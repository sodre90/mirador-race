import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSwebench, SWEBENCH_CHECK } from "../scripts/import-swebench.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "swebench-rows.json");

let scratch: string;
let repos: string;
let rowsFile: string;
let baseUrl: string;
let set: string;
const baseCommits: Record<string, string> = {};

async function git(folder: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout;
}

const read = (file: string) => readFile(file, "utf8");
const problem = (id: string) => join(set, "problems", id);
const filesOn = async (branch: string) => (await git(set, ["ls-tree", "-r", "--name-only", branch])).trim().split("\n");

/** The two upstream repositories the fixture's patches apply to, each with one commit. */
async function makeRepo(name: string, files: Record<string, string>) {
  const folder = join(repos, name);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(folder, path, ".."), { recursive: true });
    await writeFile(join(folder, path), content);
  }
  await git(folder, ["-c", "init.defaultBranch=main", "init", "-q"]);
  await git(folder, ["add", "-A"]);
  await git(folder, ["commit", "-qm", "base"]);
  baseCommits[name] = (await git(folder, ["rev-parse", "HEAD"])).trim();
}

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "swebench-test-")));
  repos = join(scratch, "repos");
  set = join(scratch, "set");
  baseUrl = `file://${repos}`;
  await makeRepo("demo/alpha", {
    "calc.py": "def combine(a, b):\n    return a + b\n",
    "README.md": "# Alpha\n",
  });
  await makeRepo("demo/beta", {
    "lib/util.py": 'def greet(name):\n    return "hello"\n',
  });
  const fixture = JSON.parse(await read(FIXTURE)) as { rows: { row: { repo: string; base_commit: string } }[] };
  fixture.rows.forEach(({ row }) => (row.base_commit = baseCommits[row.repo]!));
  rowsFile = join(scratch, "rows.json");
  await writeFile(rowsFile, JSON.stringify(fixture));
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

test("each instance becomes a problem with its task, reference, check and a start branch at its base commit", async () => {
  const report = await importSwebench(set, { rowsFile, baseUrl });

  expect(report).toEqual({ problems: 2, skipped: [] });
  expect(await read(join(set, "set.json"))).toBe('{\n  "name": "SWE-bench Verified Mini",\n  "checkTimeoutMinutes": 30,\n  "agentTimeLimitMinutes": 30,\n  "tries": 2\n}\n');
  expect((await git(set, ["rev-parse", "start/demo__alpha-1"])).trim()).toBe(baseCommits["demo/alpha"]);
  expect((await git(set, ["rev-parse", "start/demo__beta-2"])).trim()).toBe(baseCommits["demo/beta"]);
  expect(await filesOn("start/demo__alpha-1")).toEqual(["README.md", "calc.py"]);
  expect(await filesOn("start/demo__beta-2")).toEqual(["lib/util.py"]);

  expect(await read(join(problem("demo__alpha-1"), "task.md"))).toBe(
    "The calculator adds when it should subtract.\n\n`combine(a, b)` in `calc.py` returns `a + b`, but the issue asks for `a - b`.\n\nFix the issue above in this repository. Don't change its tests.\n",
  );
  expect(JSON.parse(await read(join(problem("demo__alpha-1"), "problem.json")))).toEqual({
    start: "start/demo__alpha-1",
    check: `sh swebench-check.sh demo__alpha-1 ${baseCommits["demo/alpha"]}`,
    tags: ["swebench", "demo/alpha"],
  });
  expect(await read(join(problem("demo__alpha-1"), "check", "swebench-check.sh"))).toBe(SWEBENCH_CHECK);
  expect(await read(join(problem("demo__alpha-1"), "reference", "calc.py"))).toBe("def combine(a, b):\n    return a - b\n");
  expect(await read(join(problem("demo__alpha-1"), "reference", "helper.py"))).toBe('def hint():\n    return "subtract"\n');
  expect((await readdir(join(problem("demo__alpha-1"), "reference"))).sort()).toEqual(["calc.py", "helper.py"]);
  expect(await read(join(problem("demo__beta-2"), "reference", "lib", "util.py"))).toBe('def greet(name):\n    return "hello " + name\n');

  expect((await git(set, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
  expect(await git(set, ["status", "--porcelain"])).toBe("");
  expect((await git(set, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
  expect((await git(set, ["log", "-1", "--format=%s"])).trim()).toBe("Import 2 SWE-bench Verified Mini problems");
  expect(existsSync(join(set, "calc.py")), "the set's own files stay untouched").toBe(false);
  expect((await git(set, ["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
});

test("--limit imports only the first instances", async () => {
  const report = await importSwebench(set, { rowsFile, baseUrl, limit: 1 });

  expect(report).toEqual({ problems: 1, skipped: [] });
  expect((await readdir(join(set, "problems"))).sort()).toEqual(["demo__alpha-1"]);
  expect((await git(set, ["branch", "--list", "start/demo__beta-2"])).trim()).toBe("");
});

test("an instance id that isn't a problem id is skipped, with why, and the rest come in", async () => {
  const fixture = JSON.parse(await read(rowsFile)) as { rows: { row: Record<string, unknown> }[] };
  fixture.rows.push({ row: { ...fixture.rows[0]!.row, instance_id: "Bad Id!" } });
  await writeFile(rowsFile, JSON.stringify(fixture));

  const report = await importSwebench(set, { rowsFile, baseUrl });

  expect(report.problems).toBe(2);
  expect(report.skipped).toEqual([
    { id: "Bad Id!", why: "its instance id isn't a problem id: lower case letters, digits, dots, dashes or underscores, starting with a letter or digit." },
  ]);
  expect((await readdir(join(set, "problems"))).sort()).toEqual(["demo__alpha-1", "demo__beta-2"]);
});

test("importing again replaces a problem, and an import that changed nothing adds no commit", async () => {
  await importSwebench(set, { rowsFile, baseUrl });
  await writeFile(join(problem("demo__alpha-1"), "stale.txt"), "left over\n");
  await git(set, ["add", "-A"]);
  await git(set, ["commit", "-qm", "a stray file in the problem"]);

  const report = await importSwebench(set, { rowsFile, baseUrl });

  expect(report.problems).toBe(2);
  expect(existsSync(join(problem("demo__alpha-1"), "stale.txt")), "the problem's folder was replaced").toBe(false);
  expect((await git(set, ["rev-list", "--count", "HEAD"])).trim()).toBe("3");

  await importSwebench(set, { rowsFile, baseUrl });

  expect(await git(set, ["status", "--porcelain"])).toBe("");
  expect((await git(set, ["rev-list", "--count", "HEAD"])).trim(), "an import that changed nothing adds no commit").toBe("3");
});

test("a set folder with uncommitted changes, or inside another repository, is refused", async () => {
  const dirty = join(scratch, "dirty");
  await mkdir(dirty);
  await git(dirty, ["-c", "init.defaultBranch=main", "init", "-q"]);
  await writeFile(join(dirty, "uncommitted.txt"), "not committed\n");
  await expect(importSwebench(dirty, { rowsFile, baseUrl })).rejects.toThrow(`${dirty} has uncommitted changes; commit or stash them first.`);

  await git(scratch, ["-c", "init.defaultBranch=main", "init", "-q"]);
  const nested = join(scratch, "nested");
  await expect(importSwebench(nested, { rowsFile, baseUrl })).rejects.toThrow(`${nested} must be the top folder of its git repository.`);
});
