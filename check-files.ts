import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

/** What a racer's folder had at the paths the hidden check files cover, so it can be put back after the check. */
export interface KeptOwnFiles {
  /** A temp folder holding the racer's own copies of the files the check files replaced, at the same paths. */
  backup: string;
  /** The covered paths, relative to the racer's folder, each with whether the racer had a file there. */
  paths: { path: string; had: boolean }[];
}

/** Every file below the folder, as paths relative to it, sorted. */
export async function filesIn(folder: string): Promise<string[]> {
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() ? [relative(folder, full)] : [];
      }),
    );
    return nested.flat();
  };
  return (await walk(folder)).sort();
}

async function copyKeepingMode(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  await chmod(to, (await stat(from)).mode);
}

const isFile = (path: string) => stat(path).then((each) => each.isFile(), () => false);

/** Copies the check files over the racer's folder at the same paths, keeping what the racer had there to put back after. */
export async function copyCheckFilesOver(checkFiles: string, folder: string): Promise<KeptOwnFiles> {
  const backup = await mkdtemp(join(tmpdir(), "race-own-files-"));
  const files = await filesIn(checkFiles);
  const paths = await Promise.all(
    files.map(async (path) => {
      const own = join(folder, path);
      const had = await isFile(own);
      if (had) await copyKeepingMode(own, join(backup, path));
      return { path, had };
    }),
  );
  await Promise.all(files.map((path) => copyKeepingMode(join(checkFiles, path), join(folder, path))));
  return { backup, paths };
}

/** Puts back exactly what the racer had at the covered paths, removes the folders copying made that are empty again, and takes the backup away. */
export async function putBackOwnFiles(folder: string, kept: KeptOwnFiles): Promise<void> {
  await Promise.all(
    kept.paths.map(async ({ path, had }) => {
      const own = join(folder, path);
      if (had) await copyKeepingMode(join(kept.backup, path), own);
      else await rm(own, { force: true });
    }),
  );
  const madeFolders = new Set(kept.paths.filter(({ had }) => !had).flatMap(({ path }) => ancestorsOf(dirname(path))));
  const deepestFirst = [...madeFolders].sort((one, other) => other.split(sep).length - one.split(sep).length);
  for (const dir of deepestFirst) await rmdir(join(folder, dir)).catch(() => {});
  await rm(kept.backup, { recursive: true, force: true });
}

/** A folder and its parents up to, but not including, the racer's folder itself. */
function ancestorsOf(dir: string): string[] {
  if (dir === "." || dir === "" || dir === sep) return [];
  return [dir, ...ancestorsOf(dirname(dir))];
}
