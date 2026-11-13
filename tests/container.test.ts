import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsOf, type BenchContainer, type BenchRun } from "../bench.ts";
import { BENCH_ITEM_TYPE } from "../bench-host.ts";
import { containerCommand, runContainerCheck } from "../container.ts";
import host from "../host.ts";
import { loadSet, validateProblem } from "../sets.ts";
import { fakeMirador, finished, git, until } from "./fake-mirador.ts";

const FAKE_ENGINE = `#!/bin/sh
printf '%s\\0' "$0" "$@" > "$FAKE_ENGINE_ARGS"
for command; do :; done
folder=$(mktemp -d)
printf '%s' "$folder" > "$FAKE_ENGINE_FOLDER"
trap 'rm -rf "$folder"' EXIT
trap 'exit 143' TERM
cd "$folder" || exit 1
sh -lc "$command"
status=$?
exit $status
`;

const FAKE_SSH = `#!/bin/sh
printf '%s\\0' "$@" > "$FAKE_SSH_ARGS"
shift
exec "$@"
`;

const SHELL_WITHOUT_PROFILE = `#!/bin/sh
exec /bin/sh -c "$2"
`;

let scratch: string;
let bin: string;
let keptPath: string;
let keptShell: string;

const writeScript = async (name: string, text: string) => {
  const file = join(bin, name);
  await writeFile(file, text);
  await chmod(file, 0o755);
};

const recorded = (file: string) => readFileSync(file, "utf8").split("\0").slice(0, -1);

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "container-test-")));
  bin = join(scratch, "bin");
  await mkdir(bin);
  await writeScript("docker", FAKE_ENGINE);
  await writeScript("podman", FAKE_ENGINE);
  await writeScript("ssh", FAKE_SSH);
  await writeScript("shell", SHELL_WITHOUT_PROFILE);
  keptPath = process.env.PATH ?? "";
  keptShell = process.env.SHELL ?? "";
  process.env.PATH = `${bin}:${keptPath}`;
  process.env.SHELL = join(bin, "shell");
  process.env.FAKE_ENGINE_ARGS = join(scratch, "engine-args");
  process.env.FAKE_ENGINE_FOLDER = join(scratch, "engine-folder");
  process.env.FAKE_SSH_ARGS = join(scratch, "ssh-args");
});

afterEach(async () => {
  process.env.PATH = keptPath;
  process.env.SHELL = keptShell;
  delete process.env.FAKE_ENGINE_ARGS;
  delete process.env.FAKE_ENGINE_FOLDER;
  delete process.env.FAKE_SSH_ARGS;
  await rm(scratch, { recursive: true, force: true });
});

const CONTAINER: BenchContainer = { image: "test-image", workdir: "/work", engine: "docker" };
const CHECK_SH = "grep -qx 42 answer.txt && test -f notes.txt && test ! -e secret.txt && test ! -e .git && echo container-check-ok\n";

/** A racer's git folder: answer.txt tracked and changed, notes.txt untracked, secret.txt ignored, its own decoy check.sh. */
async function racerFolder(answer: string) {
  const folder = join(scratch, "racer");
  await mkdir(folder);
  await git(folder, ["-c", "init.defaultBranch=main", "init", "-q"]);
  await writeFile(join(folder, "answer.txt"), "0\n");
  await writeFile(join(folder, ".gitignore"), "secret.txt\n");
  await git(folder, ["add", "-A"]);
  await git(folder, ["commit", "-qm", "base"]);
  await writeFile(join(folder, "answer.txt"), answer);
  await writeFile(join(folder, "notes.txt"), "how I solved it\n");
  await writeFile(join(folder, "secret.txt"), "ignored\n");
  await writeFile(join(folder, "check.sh"), "echo the racer's own check\nexit 1\n");
  return folder;
}

const checkFiles = async (text: string) => {
  const folder = join(scratch, "check");
  await mkdir(folder);
  await writeFile(join(folder, "check.sh"), text);
  return folder;
};

test("settingsOf reads a container, defaulting the engine to docker here and podman over ssh", () => {
  expect(settingsOf({ container: { image: "python:3.12", workdir: "/testbed" } }, "tiny")).toEqual({
    name: "tiny",
    checkTimeoutMinutes: 3,
    agentTimeLimitMinutes: 30,
    tries: 2,
    container: { image: "python:3.12", workdir: "/testbed", engine: "docker" },
  });
  expect(settingsOf({ container: { image: "i", workdir: "/w", host: "bench-box" } }, "tiny")).toMatchObject({
    container: { image: "i", workdir: "/w", host: "bench-box", engine: "podman" },
  });
  expect(settingsOf({ container: { image: "i", workdir: "/w", host: "bench-box", engine: "docker" } }, "tiny")).toMatchObject({
    container: { host: "bench-box", engine: "docker" },
  });
  expect(settingsOf({}, "tiny")).toEqual({ name: "tiny", checkTimeoutMinutes: 3, agentTimeLimitMinutes: 30, tries: 2 });
});

test("settingsOf says what each wrong container field must be", () => {
  expect(settingsOf({ container: [] }, "tiny")).toBe("set.json's container must hold an object.");
  expect(settingsOf({ container: { workdir: "/w" } }, "tiny")).toBe("set.json's container.image must be a non-empty string.");
  expect(settingsOf({ container: { image: "", workdir: "/w" } }, "tiny")).toBe("set.json's container.image must be a non-empty string.");
  expect(settingsOf({ container: { image: "i", workdir: "w" } }, "tiny")).toBe("set.json's container.workdir must be a full path in the container, such as /testbed.");
  expect(settingsOf({ container: { image: "i", workdir: "/w", host: "" } }, "tiny")).toBe("set.json's container.host must be a non-empty string, or left out for this machine.");
  expect(settingsOf({ container: { image: "i", workdir: "/w", engine: "rkt" } }, "tiny")).toBe("set.json's container.engine must be docker or podman.");
});

test("containerCommand puts ssh and the engine in front of the run, and quotes its paths", () => {
  const command = containerCommand({ image: "test-image", workdir: "/work", host: "bench box", engine: "podman" }, "/check files", "sh check.sh", "/racer's folder");
  expect(command).toContain("'ssh' 'bench box' 'podman' 'run' '-i' '--rm' '-w' '/work' 'test-image' 'sh' '-lc' 'tar --ignore-zeros -xf - && sh check.sh'");
  expect(command).toContain("'/racer'\\''s folder'");
  expect(command).toContain("'/check files'");
  expect(containerCommand(CONTAINER, "/check", "sh check.sh", "/racer")).not.toContain("ssh");
});

test("the folder's tracked and untracked files and the check files arrive in the container, and the check passes", async () => {
  const folder = await racerFolder("42\n");
  const check = await checkFiles(CHECK_SH);

  const running = runContainerCheck(CONTAINER, check, "sh check.sh", folder, { timeoutMs: 30_000 });
  const result = await running.result;

  expect(result).toMatchObject({ outcome: "passed", exitCode: 0 });
  expect(result.output).toContain("container-check-ok");
  expect(recorded(process.env.FAKE_ENGINE_ARGS!)).toEqual([
    join(bin, "docker"),
    "run",
    "-i",
    "--rm",
    "-w",
    "/work",
    "test-image",
    "sh",
    "-lc",
    "tar --ignore-zeros -xf - && sh check.sh",
  ]);
  expect(existsSync(readFileSync(process.env.FAKE_ENGINE_FOLDER!, "utf8")), "the container's folder is gone").toBe(false);
  expect(readFileSync(join(folder, "check.sh"), "utf8"), "the racer's own files stay as they were").toBe("echo the racer's own check\nexit 1\n");
});

test("a failing check in the container fails with what it printed", async () => {
  const folder = await racerFolder("0\n");
  const check = await checkFiles("echo expected 42 in answer.txt\nexit 1\n");

  const result = await runContainerCheck(CONTAINER, check, "sh check.sh", folder, { timeoutMs: 30_000 }).result;

  expect(result).toMatchObject({ outcome: "failed", exitCode: 1 });
  expect(result.output).toContain("expected 42 in answer.txt");
});

test("a container check that runs out of time ends as timed out, and its processes stop", async () => {
  const folder = await racerFolder("42\n");
  const check = await checkFiles("echo slow\nsleep 30\n");

  const running = runContainerCheck(CONTAINER, check, "sh check.sh", folder, { timeoutMs: 2_000 });
  const result = await running.result;

  expect(result).toMatchObject({ outcome: "timed out", exitCode: null });
  expect(result.output).toContain("slow");
  const groupAlive = () => {
    try {
      process.kill(-running.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  await until(() => !groupAlive(), "the check's process group ended");
});

test("an ssh host puts ssh in front of the run, with podman as the engine", async () => {
  const folder = await racerFolder("42\n");
  const check = await checkFiles(CHECK_SH);
  const settings = settingsOf({ container: { image: "test-image", workdir: "/work", host: "bench-box" } }, "tiny");
  if (typeof settings === "string") throw new Error(settings);

  const result = await runContainerCheck(settings.container!, check, "sh check.sh", folder, { timeoutMs: 30_000 }).result;

  expect(result).toMatchObject({ outcome: "passed", exitCode: 0 });
  expect(recorded(process.env.FAKE_SSH_ARGS!)).toEqual([
    "bench-box",
    "podman",
    "run",
    "-i",
    "--rm",
    "-w",
    "/work",
    "test-image",
    "sh",
    "-lc",
    "tar --ignore-zeros -xf - && sh check.sh",
  ]);
  expect(recorded(process.env.FAKE_ENGINE_ARGS!)[0]).toBe(join(bin, "podman"));
});

/** A set whose checks run in the container, with one problem: make answer.txt hold 42. */
async function containerSet(settings: Record<string, unknown> = {}) {
  const set = join(scratch, "set");
  await mkdir(set);
  await git(set, ["-c", "init.defaultBranch=main", "init", "-q"]);
  await git(set, ["checkout", "-q", "--orphan", "start/answer"]);
  await writeFile(join(set, "answer.txt"), "0\n");
  await git(set, ["add", "-A"]);
  await git(set, ["commit", "-qm", "start"]);
  await git(set, ["checkout", "-q", "--orphan", "main"]);
  await git(set, ["rm", "-rqf", "."]);
  await writeFile(join(set, "set.json"), JSON.stringify({ name: "Tiny", container: { image: "test-image", workdir: "/work" }, ...settings }));
  const problem = join(set, "problems", "answer");
  await mkdir(join(problem, "check"), { recursive: true });
  await writeFile(join(problem, "problem.json"), JSON.stringify({ start: "start/answer", check: "sh check.sh" }));
  await writeFile(join(problem, "task.md"), "Make the answer 42.\n");
  await writeFile(join(problem, "check", "check.sh"), "grep -qx 42 answer.txt && echo container-check-ok\n");
  await mkdir(join(problem, "reference"));
  await writeFile(join(problem, "reference", "answer.txt"), "42\n");
  await git(set, ["add", "-A"]);
  await git(set, ["commit", "-qm", "set"]);
  return set;
}

test("validateProblem checks in the container when the set has one", async () => {
  const set = await containerSet();
  const loaded = await loadSet(set);

  expect(loaded.settings.container).toEqual(CONTAINER);
  expect(await validateProblem(loaded, loaded.problems[0]!)).toEqual({ problem: "answer", validation: "valid", output: "container-check-ok\n" });
  expect(recorded(process.env.FAKE_ENGINE_ARGS!)[0]).toBe(join(bin, "docker"));
});

test("a bench run checks a cell in the container, leaving the racer's folder as it was", async () => {
  const repo = await containerSet();
  const mirador = fakeMirador<BenchRun>({ repo, scratch, itemType: BENCH_ITEM_TYPE });
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => mirador.started.length === 1, "the racer started");
  const { folder } = mirador.started[0]!;
  await writeFile(join(folder, "answer.txt"), "42\n");

  await mirador.replied(1, finished("done"));

  expect(mirador.page().cells[0]).toMatchObject({ state: "done", result: "passed" });
  expect(mirador.page().cells[0]!.tries[0]!.check).toMatchObject({ outcome: "passed", exitCode: 0 });
  expect(existsSync(join(folder, "check.sh")), "the check files went into the container, not the folder").toBe(false);
  expect(recorded(process.env.FAKE_ENGINE_ARGS!)[0]).toBe(join(bin, "docker"));
  expect(mirador.page().phase).toBe("done");
  expect(host.items[BENCH_ITEM_TYPE]!.outcome!(mirador.page())).toBe("done");
});
