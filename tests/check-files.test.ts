import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyCheckFilesOver, filesIn, putBackOwnFiles } from "../check-files.ts";

let scratch: string;
let racer: string;
let hidden: string;

async function git(folder: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "check-files-test-"));
  racer = join(scratch, "racer");
  hidden = join(scratch, "hidden");
  await mkdir(racer, { recursive: true });
  await mkdir(hidden, { recursive: true });
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

test("filesIn lists every file below the folder, relative and sorted", async () => {
  await mkdir(join(hidden, "tests/deep"), { recursive: true });
  await writeFile(join(hidden, "run.sh"), "");
  await writeFile(join(hidden, "tests/b.test.ts"), "");
  await writeFile(join(hidden, "tests/deep/a.test.ts"), "");
  expect(await filesIn(hidden)).toEqual(["run.sh", "tests/b.test.ts", "tests/deep/a.test.ts"]);
});

test("check files replace the racer's own at the same paths, and the racer's own come back after, with their modes", async () => {
  await mkdir(join(racer, "tests"), { recursive: true });
  await writeFile(join(racer, "tests/a.test.ts"), "the racer's test\n");
  await chmod(join(racer, "tests/a.test.ts"), 0o644);
  await writeFile(join(racer, "run.sh"), "the racer's run\n");
  await chmod(join(racer, "run.sh"), 0o755);
  await mkdir(join(hidden, "tests"), { recursive: true });
  await writeFile(join(hidden, "tests/a.test.ts"), "the hidden test\n");
  await writeFile(join(hidden, "run.sh"), "the hidden run\n");

  const kept = await copyCheckFilesOver(hidden, racer);
  expect(await readFile(join(racer, "tests/a.test.ts"), "utf8")).toBe("the hidden test\n");
  expect(await readFile(join(racer, "run.sh"), "utf8")).toBe("the hidden run\n");

  await putBackOwnFiles(racer, kept);
  expect(await readFile(join(racer, "tests/a.test.ts"), "utf8")).toBe("the racer's test\n");
  expect(await readFile(join(racer, "run.sh"), "utf8")).toBe("the racer's run\n");
  expect(await modeOf(join(racer, "tests/a.test.ts"))).toBe(0o644);
  expect(await modeOf(join(racer, "run.sh"))).toBe(0o755);
  expect(existsSync(kept.backup), "the backup is taken away after").toBe(false);
});

test("a check file the racer didn't have is removed after, with the folders copying made", async () => {
  await mkdir(join(hidden, "hidden/deep"), { recursive: true });
  await writeFile(join(hidden, "hidden/deep/b.test.ts"), "the hidden b\n");

  const kept = await copyCheckFilesOver(hidden, racer);
  expect(await readFile(join(racer, "hidden/deep/b.test.ts"), "utf8")).toBe("the hidden b\n");

  await putBackOwnFiles(racer, kept);
  expect(existsSync(join(racer, "hidden/deep/b.test.ts"))).toBe(false);
  expect(existsSync(join(racer, "hidden/deep"))).toBe(false);
  expect(existsSync(join(racer, "hidden"))).toBe(false);
});

test("the racer's other files and its git index are left alone", async () => {
  await git(racer, ["-c", "init.defaultBranch=main", "init", "-q"]);
  await writeFile(join(racer, "app.ts"), "export const answer = 1;\n");
  await git(racer, ["add", "-A"]);
  await git(racer, ["commit", "-qm", "base"]);
  await writeFile(join(racer, "app.ts"), "export const answer = 42;\n");
  await writeFile(join(racer, "staged.ts"), "staged\n");
  await git(racer, ["add", "staged.ts"]);
  await writeFile(join(racer, "notes.md"), "notes\n");
  const before = await git(racer, ["status", "--porcelain"]);

  await mkdir(join(hidden, "tests"), { recursive: true });
  await writeFile(join(hidden, "tests/a.test.ts"), "the hidden test\n");
  await writeFile(join(hidden, "app.ts"), "the hidden app\n");

  const kept = await copyCheckFilesOver(hidden, racer);
  await putBackOwnFiles(racer, kept);

  expect(await git(racer, ["status", "--porcelain"])).toBe(before);
  expect(await readFile(join(racer, "app.ts"), "utf8")).toBe("export const answer = 42;\n");
  expect(await readFile(join(racer, "notes.md"), "utf8")).toBe("notes\n");
  expect(existsSync(join(racer, "tests"))).toBe(false);
});
