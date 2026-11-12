import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

async function git(folder: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["git", "-C", folder, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

async function mustGit(folder: string, args: string[], env: Record<string, string> = {}) {
  const result = await git(folder, args, env);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${folder}: ${result.stderr.trim()}`);
  return result.stdout;
}

/**
 * The commit every racer started from: the newest one all their branches share. Null until git knows every branch,
 * which it does once Mirador has made each racer's worktree.
 */
export async function raceBase(folder: string, branches: string[]): Promise<string | null> {
  const found = await git(folder, ["merge-base", "--octopus", ...branches]);
  return found.exitCode === 0 ? found.stdout.trim() || null : null;
}

/**
 * Runs `diff` against everything in the racer's folder, committed or not, new files included: on a copy of its index,
 * so the racer's own staging is never touched while it works.
 */
async function withEverythingStaged<T>(folder: string, diff: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "mirador-race-"));
  try {
    const index = join(scratch, "index");
    const racersIndex = (await mustGit(folder, ["rev-parse", "--git-path", "index"])).trim();
    const copied = await copyFile(isAbsolute(racersIndex) ? racersIndex : resolve(folder, racersIndex), index).then(
      () => true,
      () => false,
    );
    const env = { GIT_INDEX_FILE: index };
    if (!copied) await mustGit(folder, ["read-tree", "HEAD"], env);
    await mustGit(folder, ["add", "--all", "--", "."], env);
    return await diff(env);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** What the racer changed since the race's base, in a few words, e.g. "3 files, +40 −5"; "no changes" when none. */
export async function changesOf(folder: string, base: string): Promise<string> {
  const stat = await withEverythingStaged(folder, (env) => mustGit(folder, ["diff", "--cached", "--shortstat", base], env));
  const files = Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0);
  if (files === 0) return "no changes";
  const added = Number(stat.match(/(\d+) insertions?/)?.[1] ?? 0);
  const removed = Number(stat.match(/(\d+) deletions?/)?.[1] ?? 0);
  return `${files} ${files === 1 ? "file" : "files"}, +${added} −${removed}`;
}

/** The racer's work since the race's base, as a patch, committed or not, new files included. */
export function diffOf(folder: string, base: string): Promise<string> {
  return withEverythingStaged(folder, (env) => mustGit(folder, ["diff", "--cached", "--no-color", "--find-renames", base], env));
}
