import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunningCheck } from "../check.ts";
import { copyCheckFiles, copyReferenceFiles, loadSet, validateProblem } from "../sets.ts";

let scratch: string;
let set: string;

async function git(folder: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout;
}

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "sets-test-")));
  set = join(scratch, "set");
  await mkdir(set);
  await git(set, ["-c", "init.defaultBranch=main", "init", "-q"]);
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

function writeFiles(folder: string, files: Record<string, string | null>) {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    const file = join(folder, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

async function commitStart(files: Record<string, string>) {
  await git(set, ["checkout", "-q", "--orphan", "start/answer"]);
  writeFiles(set, files);
  await git(set, ["add", "-A"]);
  await git(set, ["commit", "-qm", "start"]);
  await git(set, ["checkout", "-q", "--orphan", "main"]);
  await git(set, ["rm", "-rqf", "."]);
}

function writeProblem(id: string, files: Record<string, string | null> = {}) {
  writeFiles(join(set, "problems", id), {
    "problem.json": JSON.stringify({ start: "start/answer", check: "sh check.sh" }),
    "task.md": "Make the answer 42.\n",
    "check/check.sh": "grep -qx 42 answer.txt\n",
    ...files,
  });
}

async function commitSet() {
  await git(set, ["add", "-A"]);
  await git(set, ["commit", "-qm", "set"]);
}

test("a set loads its settings, commit and problems, sorted, each with its task and folders", async () => {
  await commitStart({ "answer.txt": "0\n" });
  writeFiles(set, { "set.json": JSON.stringify({ name: "Tiny", tries: 1 }) });
  writeProblem("two-fer", {
    "problem.json": JSON.stringify({ start: "start/answer", check: "sh check.sh", tags: ["strings"] }),
    "reference/answer.txt": "42\n",
  });
  writeProblem("bob", { "check/check.sh": null });
  await mkdir(join(set, "problems", "bob", "check"));
  await commitSet();

  const loaded = await loadSet(set);

  expect(loaded.folder).toBe(set);
  expect(loaded.settings).toEqual({ name: "Tiny", checkTimeoutMinutes: 3, agentTimeLimitMinutes: 30, tries: 1 });
  expect(loaded.commit).toBe((await git(set, ["rev-parse", "HEAD"])).trim());
  expect(loaded.problemsLeftOut).toEqual([]);
  expect(loaded.problems).toEqual([
    {
      id: "bob",
      start: "start/answer",
      check: "sh check.sh",
      tags: [],
      task: "Make the answer 42.\n",
      folder: join(set, "problems", "bob"),
      checkFiles: join(set, "problems", "bob", "check"),
      referenceFiles: null,
    },
    {
      id: "two-fer",
      start: "start/answer",
      check: "sh check.sh",
      tags: ["strings"],
      task: "Make the answer 42.\n",
      folder: join(set, "problems", "two-fer"),
      checkFiles: join(set, "problems", "two-fer", "check"),
      referenceFiles: join(set, "problems", "two-fer", "reference"),
    },
  ]);

  const bare = join(scratch, "bare");
  await mkdir(bare);
  await git(bare, ["-c", "init.defaultBranch=main", "init", "-q"]);
  writeFileSync(join(bare, "set.json"), "{}");
  await git(bare, ["add", "-A"]);
  await git(bare, ["commit", "-qm", "set"]);
  const empty = await loadSet(bare);
  expect(empty.problems).toEqual([]);
  expect(empty.problemsLeftOut).toEqual([]);
  expect(empty.settings.name).toBe("bare");
});

test("a set with no set.json, a bad set.json, or below its repository's top folder is refused, saying why", async () => {
  await commitStart({ "answer.txt": "0\n" });
  await mkdir(join(set, "problems"));

  await expect(loadSet(set)).rejects.toThrow(`${set} isn't a problem set: it has no set.json.`);
  writeFileSync(join(set, "set.json"), "{ nope");
  await expect(loadSet(set)).rejects.toThrow(`${set}/set.json: `);
  writeFileSync(join(set, "set.json"), JSON.stringify({ tries: 3 }));
  await expect(loadSet(set)).rejects.toThrow(`${set}/set.json: set.json's tries must be 1 or 2.`);
  await expect(loadSet(join(set, "problems"))).rejects.toThrow(`${join(set, "problems")} isn't a problem set: a set is the top folder of a git repository.`);
  const plain = join(scratch, "plain");
  await mkdir(plain);
  await expect(loadSet(plain)).rejects.toThrow(`${plain} isn't a problem set: a set is the top folder of a git repository.`);
});

test("problems with a missing problem.json, a bad spec, a blank task, no check folder or a start that isn't a commit are left out, each with why", async () => {
  await commitStart({ "answer.txt": "0\n" });
  writeFiles(set, { "set.json": "{}" });
  writeProblem("no-spec", { "problem.json": null });
  writeProblem("bad-json", { "problem.json": "{ nope" });
  writeProblem("bad-spec", { "problem.json": JSON.stringify({ start: "start/answer" }), "task.md": null, "check/check.sh": null });
  writeProblem("blank-task", { "task.md": " \n\t", "check/check.sh": null });
  writeProblem("no-task", { "task.md": null });
  writeProblem("no-check", { "check/check.sh": null });
  writeProblem("bad-start", { "problem.json": JSON.stringify({ start: "no-such-commit", check: "sh check.sh" }) });
  writeProblem("good");
  await commitSet();

  const loaded = await loadSet(set);

  expect(loaded.problems.map(({ id }) => id)).toEqual(["good"]);
  expect(loaded.problemsLeftOut).toEqual([
    { id: "bad-json", why: "its problem.json isn't JSON" },
    { id: "bad-spec", why: "problem.json's check must be a command." },
    { id: "bad-start", why: "its start, no-such-commit, isn't a commit of the set's repository" },
    { id: "blank-task", why: "its task.md is missing or blank" },
    { id: "no-check", why: "it has no check folder" },
    { id: "no-spec", why: "it has no problem.json" },
    { id: "no-task", why: "its task.md is missing or blank" },
  ]);
});

test("a problem's check files are copied into a racer's folder, over the racer's own copies", async () => {
  await commitStart({ "answer.txt": "0\n" });
  writeFiles(set, { "set.json": "{}" });
  writeProblem("answer", { "check/tests/inner.txt": "hidden\n", "reference/answer.txt": "42\n" });
  writeProblem("bare");
  await commitSet();
  const { problems } = await loadSet(set);
  const problem = problems.find(({ id }) => id === "answer")!;
  const racer = join(scratch, "racer");
  writeFiles(racer, { "check.sh": "the racer's own copy\n", "answer.txt": "0\n" });

  await copyCheckFiles(problem, racer);

  expect(readFileSync(join(racer, "check.sh"), "utf8")).toBe("grep -qx 42 answer.txt\n");
  expect(readFileSync(join(racer, "tests", "inner.txt"), "utf8")).toBe("hidden\n");
  expect(readFileSync(join(racer, "answer.txt"), "utf8")).toBe("0\n");

  await copyReferenceFiles(problem, racer);
  expect(readFileSync(join(racer, "answer.txt"), "utf8")).toBe("42\n");

  await copyReferenceFiles(problems.find(({ id }) => id === "bare")!, racer);
  expect(readFileSync(join(racer, "answer.txt"), "utf8")).toBe("42\n");
});

test("a problem is valid when its check fails on its start and passes with its reference", async () => {
  await commitStart({ "answer.txt": "0\n" });
  writeFiles(set, { "set.json": "{}" });
  writeProblem("answer", { "reference/answer.txt": "42\n", "reference/check.sh": "exit 1\n" });
  await commitSet();
  const loaded = await loadSet(set);

  expect(await validateProblem(loaded, loaded.problems[0]!)).toEqual({ problem: "answer", validation: "valid", output: "" });
});

test("a problem whose check already passes on its start, or still fails with its reference, or has no reference, says so", async () => {
  await commitStart({ "answer.txt": "0\n" });
  writeFiles(set, { "set.json": JSON.stringify({ checkTimeoutMinutes: 0.01 }) });
  writeProblem("already-passes", { "check/check.sh": "echo already right\n" });
  writeProblem("still-fails", { "check/check.sh": "cat answer.txt; grep -qx 42 answer.txt\n", "reference/answer.txt": "43\n" });
  writeProblem("no-reference");
  writeProblem("slow", { "problem.json": JSON.stringify({ start: "start/answer", check: "echo slow; sleep 30" }) });
  await commitSet();
  const loaded = await loadSet(set);
  const of = (id: string) => loaded.problems.find((problem) => problem.id === id)!;

  expect(await validateProblem(loaded, of("already-passes"))).toEqual({ problem: "already-passes", validation: "passes on its start", output: "already right\n" });
  expect(await validateProblem(loaded, of("still-fails"))).toEqual({ problem: "still-fails", validation: "fails with its reference", output: "43\n" });
  expect(await validateProblem(loaded, of("no-reference"))).toEqual({ problem: "no-reference", validation: "no reference", output: "" });
  expect(await validateProblem(loaded, of("slow"))).toEqual({ problem: "slow", validation: "couldn't check", output: "slow\n" });
});

test("validating leaves no worktree behind", async () => {
  await commitStart({ "answer.txt": "0\n" });
  writeFiles(set, { "set.json": "{}" });
  writeProblem("answer", { "reference/answer.txt": "42\n" });
  await commitSet();
  const loaded = await loadSet(set);
  const problem = loaded.problems[0]!;
  const worktrees = async () =>
    (await git(set, ["worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));

  await validateProblem(loaded, problem);
  expect(await worktrees()).toEqual([set]);

  const broken = (): RunningCheck => {
    throw new Error("the check blew up");
  };
  await expect(validateProblem(loaded, problem, broken)).rejects.toThrow("the check blew up");
  expect(await worktrees()).toEqual([set]);
});
