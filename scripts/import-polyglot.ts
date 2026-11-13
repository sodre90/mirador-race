import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";

const LANGUAGES = ["cpp", "go", "java", "javascript", "python", "rust"];

export const CHECKS: Record<string, string> = {
  python: "python3 -m pytest -q",
  go: "go test ./...",
  rust: "cargo test --quiet -- --include-ignored",
  java: "find src/test -name '*.java' -exec perl -pi -e 's/\\@Disabled(\\([^)]*\\))?//g' {} + && sh gradlew test --quiet",
  javascript: "perl -pi -e 's/\\bxtest\\(/test(/g' *.spec.js && npm install --no-audit --no-fund --silent >/dev/null && npm test --silent",
  cpp: "mkdir -p build && cd build && cmake -DEXERCISM_RUN_ALL_TESTS=1 .. >/dev/null && make",
};

const SET = { name: "Aider Polyglot", checkTimeoutMinutes: 5, agentTimeLimitMinutes: 30, tries: 2 };

const ADDENDUM = `####

Use the above instructions to modify the supplied files: {file_list}
Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.
Only use standard libraries, don't suggest installing any packages.`;

export interface ImportReport {
  problems: number;
  byLanguage: Record<string, number>;
  withoutReference: string[];
}

interface ExerciseConfig {
  files: { solution: string[]; test: string[]; example: string[] };
}

async function git(folder: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["git", "-C", folder, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

async function mustGit(folder: string, args: string[], env: Record<string, string> = {}) {
  const { stdout, stderr, exitCode } = await git(folder, args, env);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed in ${folder}: ${stderr.trim()}`);
  return stdout;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const readIfThere = (file: string) =>
  readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

const directoriesIn = async (folder: string) => {
  const entries = await readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

async function copyInto(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

async function taskOf(exerciseFolder: string, solutionFiles: string[]) {
  const docs = await Promise.all(["introduction.md", "instructions.md", "instructions.append.md"].map((name) => readIfThere(join(exerciseFolder, ".docs", name))));
  const addendum = ADDENDUM.replace("{file_list}", solutionFiles.map((file) => basename(file)).join(" "));
  return [...docs.filter((doc): doc is string => doc !== null), addendum].map((part) => part.trim()).join("\n\n") + "\n";
}

function exampleFor(solution: string, exampleFiles: string[]) {
  const named = exampleFiles.find((example) => basename(example) === basename(solution));
  if (named) return named;
  const sameExtension = exampleFiles.filter((example) => extname(example) === extname(solution));
  return sameExtension.length === 1 ? sameExtension[0] : undefined;
}

function referenceFor(solutionFiles: string[], exampleFiles: string[]): [string, string][] | null {
  const pairs = solutionFiles.flatMap((solution) => {
    const example = exampleFor(solution, exampleFiles);
    return example ? [[solution, example] as [string, string]] : [];
  });
  return pairs.length === solutionFiles.length ? pairs : null;
}

/** The racer's starting folder as a commit on start/<id>, built with a scratch index so the set's own files and index stay untouched. */
async function startCommit(setFolder: string, exerciseFolder: string, testFiles: string[], id: string) {
  const temp = await mkdtemp(join(tmpdir(), "polyglot-start-"));
  try {
    const work = join(temp, "work");
    await mkdir(work);
    await cp(exerciseFolder, work, {
      recursive: true,
      filter: (source) => {
        const path = relative(exerciseFolder, source);
        return path === "" || (![".meta", ".docs"].includes(path.split("/")[0]!) && !testFiles.includes(path));
      },
    });
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    await mustGit(setFolder, ["--work-tree", work, "add", "-A"], env);
    const tree = (await mustGit(setFolder, ["write-tree"], env)).trim();
    const commit = (await mustGit(setFolder, ["commit-tree", tree, "-m", `Start of ${id}`], env)).trim();
    await mustGit(setFolder, ["update-ref", `refs/heads/start/${id}`, commit]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function prepareSet(setFolder: string) {
  await mkdir(setFolder, { recursive: true });
  if ((await git(setFolder, ["rev-parse", "--git-dir"])).exitCode !== 0) await mustGit(setFolder, ["init", "-b", "main"]);
  const prefix = (await mustGit(setFolder, ["rev-parse", "--show-prefix"])).trim();
  if (prefix) throw new Error(`${setFolder} must be the top folder of its git repository.`);
  const status = await mustGit(setFolder, ["status", "--porcelain"]);
  if (status.trim()) throw new Error(`${setFolder} has uncommitted changes; commit or stash them first.`);
  await mkdir(join(setFolder, "problems"), { recursive: true });
}

async function writeProblem(setFolder: string, exerciseFolder: string, language: string, id: string, config: ExerciseConfig, report: ImportReport) {
  const problemFolder = join(setFolder, "problems", id);
  await rm(problemFolder, { recursive: true, force: true });
  await mkdir(problemFolder, { recursive: true });
  await writeFile(join(problemFolder, "problem.json"), json({ start: `start/${id}`, check: CHECKS[language], tags: [language] }));
  await writeFile(join(problemFolder, "task.md"), await taskOf(exerciseFolder, config.files.solution));
  for (const test of config.files.test) await copyInto(join(exerciseFolder, test), join(problemFolder, "check", test));
  const reference = referenceFor(config.files.solution, config.files.example);
  if (reference) for (const [solution, example] of reference) await copyInto(join(exerciseFolder, example), join(problemFolder, "reference", solution));
  else report.withoutReference.push(id);
}

function summary(report: ImportReport, setFolder: string) {
  const counts = Object.entries(report.byLanguage).map(([language, count]) => `${language} ${count}`).join(", ");
  const line = `Imported ${report.problems} problem${report.problems === 1 ? "" : "s"}${counts ? ` (${counts})` : ""} into ${setFolder}`;
  return report.withoutReference.length === 0 ? `${line}.` : `${line}; ${report.withoutReference.length} without a reference: ${report.withoutReference.join(", ")}.`;
}

/** Imports the Aider Polyglot benchmark's exercises into a problem set: a folder per problem and a start branch per racer. */
export async function importPolyglot(polyglotFolder: string, setFolder: string, { languages, limit }: { languages?: string[]; limit?: number } = {}): Promise<ImportReport> {
  const asked = languages ?? LANGUAGES;
  for (const language of asked) {
    if (!LANGUAGES.includes(language)) throw new Error(`Polyglot has no language ${language}; it has ${LANGUAGES.join(", ")}.`);
  }
  await prepareSet(setFolder);
  const report: ImportReport = { problems: 0, byLanguage: {}, withoutReference: [] };
  for (const language of LANGUAGES.filter((each) => asked.includes(each))) {
    const practice = join(polyglotFolder, language, "exercises", "practice");
    const slugs = (await directoriesIn(practice)).sort().slice(0, limit);
    for (const slug of slugs) {
      const id = `${language}-${slug}`;
      const exerciseFolder = join(practice, slug);
      const config = JSON.parse(await readFile(join(exerciseFolder, ".meta", "config.json"), "utf8")) as ExerciseConfig;
      await writeProblem(setFolder, exerciseFolder, language, id, config, report);
      await startCommit(setFolder, exerciseFolder, config.files.test, id);
      report.byLanguage[language] = (report.byLanguage[language] ?? 0) + 1;
    }
  }
  report.problems = Object.values(report.byLanguage).reduce((sum, count) => sum + count, 0);
  await writeFile(join(setFolder, "set.json"), json(SET));
  await mustGit(setFolder, ["add", "set.json", "problems"]);
  if ((await git(setFolder, ["diff", "--cached", "--quiet"])).exitCode !== 0) {
    await mustGit(setFolder, ["commit", "-m", `Import ${report.problems} Aider Polyglot problems`]);
  }
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  const positionals = args.filter((arg, at) => !arg.startsWith("--") && args[at - 1] !== "--languages" && args[at - 1] !== "--limit");
  const [polyglotFolder, setFolder] = positionals;
  if (!polyglotFolder || !setFolder) {
    console.error("Usage: bun scripts/import-polyglot.ts <polyglot checkout> <set folder> [--languages python,go] [--limit <n per language>]");
    process.exit(1);
  }
  const limitText = valueOf("--limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  try {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit must be a positive whole number, not "${limitText}".`);
    const report = await importPolyglot(polyglotFolder, setFolder, { languages: valueOf("--languages")?.split(","), limit });
    console.log(summary(report, setFolder));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}