import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SWEBENCH_CHECK } from "../scripts/import-swebench.ts";

const FAKE_UVX = `#!/bin/sh
if ! mkdir "$FAKE_UVX_BUSY" 2>/dev/null; then echo "two harness runs at once" >> "$FAKE_UVX_OVERLAP"; fi
printf '%s\\0' "$@" > "$FAKE_UVX_ARGS"
pwd > "$FAKE_UVX_CWD"
sleep "\${FAKE_UVX_SECONDS:-0}"
rmdir "$FAKE_UVX_BUSY" 2>/dev/null
prev=""
for arg; do
  case "$prev" in
    --predictions_path) cp "$arg" "$FAKE_UVX_PREDICTIONS" ;;
    --run_id) run_id="$arg" ;;
    --instance_ids) instance_id="$arg" ;;
  esac
  prev="$arg"
done
logs="logs/run_evaluation/$run_id/race/$instance_id"
mkdir -p "$logs"
if [ "$FAKE_UVX_NO_REPORT" = "1" ]; then
  printf 'building the instance image\\nimage pull denied\\n' > "$logs/run_instance.log"
  exit "\${FAKE_UVX_EXIT:-1}"
fi
if [ "$FAKE_UVX_RESOLVED" = "1" ]; then resolved=true; else resolved=false; fi
printf '{\\n    "%s": {\\n        "patch_exists": true,\\n        "resolved": %s\\n    }\\n}\\n' "$instance_id" "$resolved" > "$logs/report.json"
printf 'line one of test output\\nFAIL tests/test_calc.py::test_combine\\n' > "$logs/test_output.txt"
exit "\${FAKE_UVX_EXIT:-0}"
`;

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\0' "$@" >> "$FAKE_DOCKER_ARGS"
if [ "$1 $2" = "image inspect" ]; then exit "\${FAKE_DOCKER_INSPECT_EXIT:-1}"; fi
if [ "$1" = pull ]; then sleep "\${FAKE_DOCKER_PULL_SECONDS:-0}"; exit "\${FAKE_DOCKER_PULL_EXIT:-0}"; fi
exit 0
`;

const TOOLS = ["git", "mktemp", "cp", "sed", "awk", "grep", "tail", "rm", "basename", "mkdir", "rmdir", "sleep", "printenv"];

let scratch: string;
let bin: string;
let folder: string;
let baseCommit: string;
const instanceId = "demo__alpha-1";

async function git(args: string[]) {
  const child = Bun.spawn(["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout;
}

async function makeBin(withUvx: boolean) {
  const dir = join(scratch, withUvx ? "bin" : "bin-without-uvx");
  await mkdir(dir);
  await Promise.all(
    TOOLS.map(async (tool) => {
      const real = Bun.which(tool);
      if (!real) throw new Error(`${tool} isn't on this machine's PATH`);
      await symlink(real, join(dir, tool));
    }),
  );
  const fakes = withUvx ? { uvx: FAKE_UVX, docker: FAKE_DOCKER } : { docker: FAKE_DOCKER };
  await Promise.all(
    Object.entries(fakes).map(async ([name, script]) => {
      await writeFile(join(dir, name), script);
      await chmod(join(dir, name), 0o755);
    }),
  );
  return dir;
}

/** The racer's folder: a base commit, a changed file with quotes, backslashes and a tab, a new file, and the check script. */
async function makeRacer() {
  folder = join(scratch, "racer");
  await mkdir(folder);
  await git(["-c", "init.defaultBranch=main", "init", "-q"]);
  await writeFile(join(folder, "calc.py"), "def combine(a, b):\n    return a + b\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  baseCommit = (await git(["rev-parse", "HEAD"])).trim();
  await writeFile(join(folder, "calc.py"), 'def combine(a, b):\n    # say "a - b", keep C:\\temp\tin mind\n    return a - b\n');
  await writeFile(join(folder, "new_file.py"), "answer = 42\n");
  await writeFile(join(folder, "swebench-check.sh"), SWEBENCH_CHECK);
  await git(["add", "calc.py"]);
}

interface CheckOptions {
  resolved?: boolean;
  noReport?: boolean;
  uvxExit?: number;
  pullExit?: number;
  inspectExit?: number;
  uvxSeconds?: number;
  pullSeconds?: number;
}

function checkEnv({ resolved = true, noReport = false, uvxExit, pullExit, inspectExit, uvxSeconds, pullSeconds }: CheckOptions = {}) {
  return {
    ...process.env,
    PATH: bin,
    TMPDIR: scratch,
    FAKE_UVX_BUSY: join(scratch, "uvx-busy"),
    FAKE_UVX_OVERLAP: join(scratch, "uvx-overlap"),
    ...(uvxSeconds === undefined ? {} : { FAKE_UVX_SECONDS: String(uvxSeconds) }),
    FAKE_DOCKER_ARGS: join(scratch, "docker-args"),
    ...(pullExit === undefined ? {} : { FAKE_DOCKER_PULL_EXIT: String(pullExit) }),
    ...(inspectExit === undefined ? {} : { FAKE_DOCKER_INSPECT_EXIT: String(inspectExit) }),
    ...(pullSeconds === undefined ? {} : { FAKE_DOCKER_PULL_SECONDS: String(pullSeconds) }),
    FAKE_UVX_ARGS: join(scratch, "uvx-args"),
    FAKE_UVX_CWD: join(scratch, "uvx-cwd"),
    FAKE_UVX_PREDICTIONS: join(scratch, "predictions.json"),
    FAKE_UVX_RESOLVED: resolved ? "1" : "0",
    FAKE_UVX_NO_REPORT: noReport ? "1" : "0",
    ...(uvxExit === undefined ? {} : { FAKE_UVX_EXIT: String(uvxExit) }),
  };
}

async function runCheckScript(options: CheckOptions = {}) {
  const child = Bun.spawn(["/bin/sh", "swebench-check.sh", instanceId, baseCommit], { cwd: folder, env: checkEnv(options), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

/** The check in a process group of its own, as runCheck runs it, so a test can stop it with TERM. */
function startCheckScript(options: CheckOptions = {}) {
  return Bun.spawn(["/bin/sh", "swebench-check.sh", instanceId, baseCommit], { cwd: folder, env: checkEnv(options), detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

/** TERMs the check's whole group once the fake harness runs, and resolves to the check's exit code. */
async function stopRunningCheck(child: ReturnType<typeof startCheckScript>) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(scratch, "uvx-args"))) {
    if (Date.now() > deadline) throw new Error("the harness never started");
    await Bun.sleep(20);
  }
  process.kill(-child.pid, "SIGTERM");
  return child.exited;
}

async function harnessContainerName() {
  const args = await recordedArgs();
  return `sweb.eval.${instanceId}.${args[args.indexOf("--run_id") + 1]}`;
}

const dockerCalls = () => readFile(join(scratch, "docker-args"), "utf8").then((text) => text.split("\0").slice(0, -1));
const recordedArgs = () => readFile(join(scratch, "uvx-args"), "utf8").then((text) => text.split("\0").slice(0, -1));
const predictions = async () => JSON.parse(await readFile(join(scratch, "predictions.json"), "utf8")) as { instance_id: string; model_name_or_path: string; model_patch: string }[];

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "swebench-check-test-")));
  bin = await makeBin(true);
  await makeRacer();
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

test("the racer's diff becomes the prediction, new files in and the check script out, without touching the racer's index", async () => {
  const { exitCode, stdout, stderr } = await runCheckScript();

  expect(stderr).toBe("");
  expect(exitCode, stdout).toBe(0);
  const [prediction] = await predictions();
  expect(prediction!.instance_id).toBe(instanceId);
  expect(prediction!.model_name_or_path).toBe("race");
  expect(prediction!.model_patch).toContain("-    return a + b");
  expect(prediction!.model_patch).toContain("+    return a - b");
  expect(prediction!.model_patch).toContain('say "a - b", keep C:\\temp\tin mind');
  expect(prediction!.model_patch).toContain("+++ b/new_file.py");
  expect(prediction!.model_patch).toContain("+answer = 42");
  expect(prediction!.model_patch).not.toContain("swebench-check.sh");

  const args = await recordedArgs();
  expect(args.slice(0, 4)).toEqual(["--python", "3.12", "--from", "swebench==4.1.0"]);
  expect(args).toContain("python");
  expect(args).toContain("-m");
  expect(args).toContain("swebench.harness.run_evaluation");
  const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
  expect(valueAfter("--dataset_name")).toBe("MariusHobbhahn/swe-bench-verified-mini");
  expect(valueAfter("--split")).toBe("test");
  expect(valueAfter("--instance_ids")).toBe(instanceId);
  expect(valueAfter("--max_workers")).toBe("1");
  expect(valueAfter("--cache_level")).toBe("env");
  expect(valueAfter("--clean")).toBe("True");
  expect(valueAfter("--run_id")).toBeTruthy();

  expect((await git(["diff", "--cached", "--name-only"])).trim(), "the racer's staging stays as it was").toBe("calc.py");
  expect(await git(["status", "--porcelain"])).toBe("M  calc.py\n?? new_file.py\n?? swebench-check.sh\n");
  expect(existsSync((await readFile(join(scratch, "uvx-cwd"), "utf8")).trim()), "the check's temp folder is gone").toBe(false);
});

test("a resolved instance passes, and an unresolved one fails with the tail of the test output", async () => {
  const passed = await runCheckScript({ resolved: true });
  expect(passed.exitCode).toBe(0);

  const failed = await runCheckScript({ resolved: false });
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).toContain(`SWE-bench did not mark ${instanceId} resolved`);
  expect(failed.stdout).toContain("FAIL tests/test_calc.py::test_combine");
  expect(existsSync((await readFile(join(scratch, "uvx-cwd"), "utf8")).trim()), "the temp folder is gone after a failure too").toBe(false);
});

test("a harness that leaves no report fails with the tail of the instance log", async () => {
  const { exitCode, stdout } = await runCheckScript({ noReport: true, uvxExit: 1 });

  expect(exitCode).toBe(1);
  expect(stdout).toContain("the harness exited with 1");
  expect(stdout).toContain("image pull denied");
});

test("without uvx it says so, and how to install uv", async () => {
  bin = await makeBin(false);

  const { exitCode, stdout } = await runCheckScript();

  expect(exitCode).toBe(1);
  expect(stdout).toContain("uvx isn't installed");
  expect(stdout).toContain("https://astral.sh/uv/install.sh");
});

test("a racer that changed nothing fails without running the harness", async () => {
  await writeFile(join(folder, "calc.py"), "def combine(a, b):\n    return a + b\n");
  await rm(join(folder, "new_file.py"));

  const { exitCode, stdout } = await runCheckScript();

  expect(exitCode).toBe(1);
  expect(stdout).toContain("No changes against");
  expect(existsSync(join(scratch, "uvx-args")), "the harness never ran").toBe(false);
});

test("the instance's x86_64 image is pulled for linux/amd64 before the harness runs, as the harness would ask for this machine's platform", async () => {
  const { exitCode } = await runCheckScript();

  expect(exitCode).toBe(0);
  const image = "swebench/sweb.eval.x86_64.demo_1776_alpha-1:latest";
  expect(await dockerCalls()).toEqual(["image", "inspect", image, "pull", "--quiet", "--platform", "linux/amd64", image]);
});

test("an image Docker can't pull fails the check without running the harness", async () => {
  const { stdout, exitCode } = await runCheckScript({ pullExit: 1 });

  expect(exitCode).toBe(1);
  expect(stdout).toContain("Docker couldn't pull swebench/sweb.eval.x86_64.demo_1776_alpha-1:latest.");
  expect(existsSync(join(scratch, "uvx-args"))).toBe(false);
});

test("two checks of one instance take turns, so one's harness never removes the image the other is about to use", async () => {
  const both = await Promise.all([runCheckScript({ uvxSeconds: 2 }), runCheckScript({ uvxSeconds: 2 })]);

  expect(both.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
  expect(existsSync(join(scratch, "uvx-overlap")), "the harness never ran twice at once").toBe(false);
  expect(existsSync(join(scratch, `race-swebench-${instanceId}.lock`)), "the lock is gone").toBe(false);
}, 20_000);

test("a lock left by a check that is gone is taken over", async () => {
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  const lock = join(scratch, `race-swebench-${instanceId}.lock`);
  await mkdir(lock);
  await writeFile(join(lock, "pid"), `${gone.pid}\n`);

  const { exitCode } = await runCheckScript();

  expect(exitCode).toBe(0);
  expect(existsSync(lock)).toBe(false);
});

test("a stopped check removes the harness's container and the image it pulled, and leaves no lock or temp folder", async () => {
  const exitCode = await stopRunningCheck(startCheckScript({ uvxSeconds: 30 }));

  expect(exitCode).toBe(143);
  const image = "swebench/sweb.eval.x86_64.demo_1776_alpha-1:latest";
  expect(await dockerCalls()).toEqual(["image", "inspect", image, "pull", "--quiet", "--platform", "linux/amd64", image, "rm", "-f", await harnessContainerName(), "rmi", image]);
  expect(existsSync(join(scratch, `race-swebench-${instanceId}.lock`)), "the lock is gone").toBe(false);
  expect(existsSync((await readFile(join(scratch, "uvx-cwd"), "utf8")).trim()), "the temp folder is gone").toBe(false);
}, 20_000);

test("a stopped check keeps an image that was there before it", async () => {
  const exitCode = await stopRunningCheck(startCheckScript({ uvxSeconds: 30, inspectExit: 0 }));

  expect(exitCode).toBe(143);
  const image = "swebench/sweb.eval.x86_64.demo_1776_alpha-1:latest";
  expect(await dockerCalls()).toEqual(["image", "inspect", image, "rm", "-f", await harnessContainerName()]);
  expect(existsSync(join(scratch, `race-swebench-${instanceId}.lock`)), "the lock is gone").toBe(false);
  expect(existsSync((await readFile(join(scratch, "uvx-cwd"), "utf8")).trim()), "the temp folder is gone").toBe(false);
}, 20_000);

test("a check stopped while it pulls the image removes what the pull left", async () => {
  const child = startCheckScript({ pullSeconds: 30 });
  const deadline = Date.now() + 10_000;
  while (!(existsSync(join(scratch, "docker-args")) && (await dockerCalls()).includes("pull"))) {
    if (Date.now() > deadline) throw new Error("the pull never started");
    await Bun.sleep(20);
  }
  process.kill(-child.pid, "SIGTERM");

  expect(await child.exited).toBe(143);
  const image = "swebench/sweb.eval.x86_64.demo_1776_alpha-1:latest";
  expect((await dockerCalls()).slice(-5), "the image, there or half there, is removed").toEqual(["rm", "-f", expect.stringMatching(/^sweb\.eval\.demo__alpha-1\.race-/), "rmi", image]);
  expect(existsSync(join(scratch, "uvx-args")), "the harness never ran").toBe(false);
}, 20_000);
