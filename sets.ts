import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { problemSpecOf, settingsOf, type BenchSettings, type ProblemSpec } from "./bench.ts";
import { runCheck, type RunningCheck } from "./check.ts";
import { runContainerCheck } from "./container.ts";

export interface Problem extends ProblemSpec {
  task: string;
  folder: string;
  checkFiles: string;
  referenceFiles: string | null;
}

export interface LoadedSet {
  folder: string;
  settings: BenchSettings;
  /** The set's checked-out commit, the one a run records. */
  commit: string;
  problems: Problem[];
  problemsLeftOut: { id: string; why: string }[];
}

async function git(folder: string, args: string[]) {
  try {
    const child = Bun.spawn(["git", "-C", folder, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
  }
}

async function mustGit(folder: string, args: string[]) {
  const { stdout, stderr, exitCode } = await git(folder, args);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed in ${folder}: ${stderr.trim()}`);
  return stdout;
}

const isDirectory = (folder: string) => stat(folder).then((entry) => entry.isDirectory(), () => false);

const readIfThere = (file: string) => readFile(file, "utf8").catch(() => null);

async function problemOf(setFolder: string, id: string): Promise<Problem | string> {
  const folder = join(setFolder, "problems", id);
  const specText = await readIfThere(join(folder, "problem.json"));
  if (specText === null) return "it has no problem.json";
  let json: unknown;
  try {
    json = JSON.parse(specText);
  } catch {
    return "its problem.json isn't JSON";
  }
  const spec = problemSpecOf(json, id);
  if (typeof spec === "string") return spec;
  const task = await readIfThere(join(folder, "task.md"));
  if (task === null || task.trim().length === 0) return "its task.md is missing or blank";
  const checkFiles = join(folder, "check");
  if (!(await isDirectory(checkFiles))) return "it has no check folder";
  const start = await git(setFolder, ["rev-parse", "--verify", "--quiet", `${spec.start}^{commit}`]);
  if (start.exitCode !== 0) return `its start, ${spec.start}, isn't a commit of the set's repository`;
  const referenceFiles = join(folder, "reference");
  return { ...spec, task, folder, checkFiles, referenceFiles: (await isDirectory(referenceFiles)) ? referenceFiles : null };
}

export async function loadSet(folder: string): Promise<LoadedSet> {
  folder = resolve(folder);
  const prefix = await git(folder, ["rev-parse", "--show-prefix"]);
  if (prefix.exitCode !== 0 || prefix.stdout.trim() !== "") throw new Error(`${folder} isn't a problem set: a set is the top folder of a git repository.`);
  const text = await readIfThere(join(folder, "set.json"));
  if (text === null) throw new Error(`${folder} isn't a problem set: it has no set.json.`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${folder}/set.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const settings = settingsOf(json, basename(folder));
  if (typeof settings === "string") throw new Error(`${folder}/set.json: ${settings}`);
  const commit = (await mustGit(folder, ["rev-parse", "HEAD"])).trim();
  const entries = await readdir(join(folder, "problems"), { withFileTypes: true }).catch(() => []);
  const problems: Problem[] = [];
  const problemsLeftOut: { id: string; why: string }[] = [];
  for (const id of entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort()) {
    const problem = await problemOf(folder, id);
    if (typeof problem === "string") problemsLeftOut.push({ id, why: problem });
    else problems.push(problem);
  }
  return { folder, settings, commit, problems, problemsLeftOut };
}

export async function copyCheckFiles(problem: Problem, into: string): Promise<void> {
  await cp(problem.checkFiles, into, { recursive: true, force: true });
}

export async function copyReferenceFiles(problem: Problem, into: string): Promise<void> {
  if (problem.referenceFiles !== null) await cp(problem.referenceFiles, into, { recursive: true, force: true });
}

export type Validation = "valid" | "passes on its start" | "fails with its reference" | "no reference" | "couldn't check";

export interface ProblemValidation {
  problem: string;
  validation: Validation;
  output: string;
}

/** A problem is valid when its check fails on its starting tree and passes with its reference solution. */
export async function validateProblem(
  set: LoadedSet,
  problem: Problem,
  check: (command: string, folder: string, options: { timeoutMs: number }) => RunningCheck = runCheck,
): Promise<ProblemValidation> {
  const temp = await mkdtemp(join(tmpdir(), "mirador-race-set-"));
  const scratch = join(temp, "worktree");
  const timeoutMs = set.settings.checkTimeoutMinutes * 60_000;
  const container = set.settings.container;
  const checkHere = container
    ? (command: string, folder: string, options: { timeoutMs: number }) => runContainerCheck(container, problem.checkFiles, command, folder, options)
    : check;
  const said = (validation: Validation, output: string): ProblemValidation => ({ problem: problem.id, validation, output });
  try {
    await mustGit(set.folder, ["worktree", "add", "--detach", "--quiet", scratch, problem.start]);
    if (!container) await copyCheckFiles(problem, scratch);
    const onStart = await checkHere(problem.check, scratch, { timeoutMs }).result;
    if (onStart.outcome === "passed") return said("passes on its start", onStart.output);
    if (onStart.outcome === "timed out" || onStart.outcome === "stopped") return said("couldn't check", onStart.output);
    if (problem.referenceFiles === null) return said("no reference", "");
    await copyReferenceFiles(problem, scratch);
    if (!container) await copyCheckFiles(problem, scratch);
    const withReference = await checkHere(problem.check, scratch, { timeoutMs }).result;
    return withReference.outcome === "passed" ? said("valid", withReference.output) : said("fails with its reference", withReference.output);
  } finally {
    await git(set.folder, ["worktree", "remove", "--force", scratch]);
    await rm(temp, { recursive: true, force: true });
  }
}
