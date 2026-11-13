import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKS, importPolyglot } from "../scripts/import-polyglot.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "polyglot");

let scratch: string;
let polyglot: string;
let set: string;

async function git(folder: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout;
}

const exercise = (language: string, slug: string) => join(polyglot, language, "exercises", "practice", slug);
const problem = (id: string) => join(set, "problems", id);
const read = (file: string) => readFile(file, "utf8");
const filesOn = async (branch: string) => (await git(set, ["ls-tree", "-r", "--name-only", branch])).trim().split("\n");
const commitOf = async (branch: string) => (await git(set, ["rev-parse", branch])).trim();
const readdirNames = async (folder: string) => (await readdir(folder)).sort();

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "polyglot-test-")));
  polyglot = join(scratch, "polyglot");
  set = join(scratch, "set");
  await cp(FIXTURE, polyglot, { recursive: true });
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

test("an exercise becomes a problem with its task, hidden tests, reference and a start branch without the tests", async () => {
  const report = await importPolyglot(polyglot, set, { languages: ["python"] });

  expect(report).toEqual({ problems: 1, byLanguage: { python: 1 }, withoutReference: [] });
  expect(await read(join(set, "set.json"))).toBe('{\n  "name": "Aider Polyglot",\n  "checkTimeoutMinutes": 5,\n  "agentTimeLimitMinutes": 30,\n  "tries": 2\n}\n');
  expect(JSON.parse(await read(join(problem("python-two-fer"), "problem.json")))).toEqual({ start: "start/python-two-fer", check: CHECKS.python, tags: ["python"] });
  const introduction = (await read(join(exercise("python", "two-fer"), ".docs", "introduction.md"))).trim();
  const instructions = (await read(join(exercise("python", "two-fer"), ".docs", "instructions.md"))).trim();
  const addendum = `####

Use the above instructions to modify the supplied files: two_fer.py
Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.
Only use standard libraries, don't suggest installing any packages.`;
  expect(await read(join(problem("python-two-fer"), "task.md"))).toBe(`${introduction}\n\n${instructions}\n\n${addendum}\n`);
  expect(await read(join(problem("python-two-fer"), "check", "two_fer_test.py"))).toBe(await read(join(exercise("python", "two-fer"), "two_fer_test.py")));
  expect(await read(join(problem("python-two-fer"), "reference", "two_fer.py"))).toBe(await read(join(exercise("python", "two-fer"), ".meta", "example.py")));
  expect(await filesOn("start/python-two-fer")).toEqual(["two_fer.py"]);
  expect((await git(set, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
});

test("a go exercise keeps its go.mod and gets go's check", async () => {
  await importPolyglot(polyglot, set, { languages: ["go"] });

  expect(JSON.parse(await read(join(problem("go-leap"), "problem.json"))).check).toBe(CHECKS.go);
  expect(await filesOn("start/go-leap")).toEqual(["go.mod", "leap.go"]);
  expect(await read(join(problem("go-leap"), "check", "leap_test.go"))).toBe(await read(join(exercise("go", "leap"), "leap_test.go")));
  expect(await read(join(problem("go-leap"), "reference", "leap.go"))).toBe(await read(join(exercise("go", "leap"), ".meta", "example.go")));
  expect(await read(join(problem("go-leap"), "task.md"))).toContain("modify the supplied files: leap.go");
});

test("an exercise whose example doesn't map gets no reference, and the report names it", async () => {
  const report = await importPolyglot(polyglot, set, { languages: ["rust"] });

  expect(report).toEqual({ problems: 1, byLanguage: { rust: 1 }, withoutReference: ["rust-odd"] });
  expect(existsSync(join(problem("rust-odd"), "reference"))).toBe(false);
  expect(await read(join(problem("rust-odd"), "check", "tests", "odd.rs"))).toBe(await read(join(exercise("rust", "odd"), "tests", "odd.rs")));
  expect(await filesOn("start/rust-odd")).toEqual(["Cargo.toml", "src/lib.rs"]);
});

test("--languages and --limit choose which exercises come in, and an unknown language is refused, naming the ones there are", async () => {
  const practice = join(polyglot, "python", "exercises", "practice");
  await cp(join(practice, "two-fer"), join(practice, "aaa"), { recursive: true });
  await cp(join(practice, "two-fer"), join(practice, "zzz"), { recursive: true });

  const report = await importPolyglot(polyglot, set, { languages: ["python", "go"], limit: 2 });

  expect(report).toEqual({ problems: 3, byLanguage: { python: 2, go: 1 }, withoutReference: [] });
  expect((await git(set, ["ls-tree", "--name-only", "HEAD", "problems/"])).trim().split("\n").sort()).toEqual(["problems/go-leap", "problems/python-aaa", "problems/python-two-fer"]);
  const onlyGo = join(scratch, "only-go");
  await importPolyglot(polyglot, onlyGo, { languages: ["go"] });
  expect(await readdirNames(join(onlyGo, "problems"))).toEqual(["go-leap"]);
  await expect(importPolyglot(polyglot, join(scratch, "refused"), { languages: ["cobol"] })).rejects.toThrow(
    "Polyglot has no language cobol; it has cpp, go, java, javascript, python, rust.",
  );
});

test("running it again replaces a problem and moves its start branch, and keeps the set's other problems", async () => {
  await importPolyglot(polyglot, set, { languages: ["python", "go"] });
  const oldPython = await commitOf("start/python-two-fer");
  const oldGo = await commitOf("start/go-leap");
  const goTask = await read(join(problem("go-leap"), "task.md"));
  await writeFile(join(problem("python-two-fer"), "stale.txt"), "left over\n");
  await git(set, ["add", "-A"]);
  await git(set, ["commit", "-qm", "a stray file in the problem"]);
  const changedStub = 'def two_fer(name="you"):\n    return "changed"\n';
  await writeFile(join(exercise("python", "two-fer"), "two_fer.py"), changedStub);

  const report = await importPolyglot(polyglot, set, { languages: ["python"] });

  expect(report).toEqual({ problems: 1, byLanguage: { python: 1 }, withoutReference: [] });
  expect(await commitOf("start/python-two-fer")).not.toBe(oldPython);
  expect(await git(set, ["show", "start/python-two-fer:two_fer.py"])).toBe(changedStub);
  expect(existsSync(join(problem("python-two-fer"), "stale.txt")), "the problem's folder was replaced").toBe(false);
  expect(await commitOf("start/go-leap")).toBe(oldGo);
  expect(await read(join(problem("go-leap"), "task.md"))).toBe(goTask);
  expect((await git(set, ["rev-list", "--count", "HEAD"])).trim()).toBe("3");
});

test("a set folder with uncommitted changes, or inside another repository, is refused", async () => {
  const dirty = join(scratch, "dirty");
  await mkdir(dirty);
  await git(dirty, ["init", "-q", "-b", "main"]);
  await writeFile(join(dirty, "uncommitted.txt"), "not committed\n");
  await expect(importPolyglot(polyglot, dirty)).rejects.toThrow(`${dirty} has uncommitted changes; commit or stash them first.`);

  await git(scratch, ["init", "-q", "-b", "main"]);
  const nested = join(scratch, "nested");
  await expect(importPolyglot(polyglot, nested)).rejects.toThrow(`${nested} must be the top folder of its git repository.`);
});

test("the import leaves the set repository's working tree clean, with one commit per import that changed something", async () => {
  const report = await importPolyglot(polyglot, set);

  expect(report).toEqual({ problems: 3, byLanguage: { go: 1, python: 1, rust: 1 }, withoutReference: ["rust-odd"] });
  expect(await git(set, ["status", "--porcelain"])).toBe("");
  expect((await git(set, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
  expect((await git(set, ["log", "-1", "--format=%s"])).trim()).toBe("Import 3 Aider Polyglot problems");

  await importPolyglot(polyglot, set);

  expect(await git(set, ["status", "--porcelain"])).toBe("");
  expect((await git(set, ["rev-list", "--count", "HEAD"])).trim(), "an import that changed nothing adds no commit").toBe("1");
});