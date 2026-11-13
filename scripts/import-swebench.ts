import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isProblemId } from "../bench.ts";
import { git, mustGit } from "../git.ts";

const ROWS_URL = "https://datasets-server.huggingface.co/rows?dataset=MariusHobbhahn/swe-bench-verified-mini&config=default&split=test&offset=0&length=100";
const DATASET = "MariusHobbhahn/swe-bench-verified-mini";
/** The newest swebench whose run_evaluation takes --cache_level and --clean; 5.x dropped them. */
const SWEBENCH_VERSION = "4.1.0";

const SET = { name: "SWE-bench Verified Mini", checkTimeoutMinutes: 30, agentTimeLimitMinutes: 30, tries: 2 };

export const SWEBENCH_CHECK = String.raw`#!/bin/sh
set -u

instance_id=$1
base_commit=$2

command -v uvx >/dev/null 2>&1 || {
  echo "uvx isn't installed. Install uv, which provides it: curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
}

work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT

own_index=$(git rev-parse --git-path index)
if [ -f "$own_index" ]; then
  cp "$own_index" "$work/index"
else
  GIT_INDEX_FILE="$work/index" git read-tree HEAD
fi
export GIT_INDEX_FILE="$work/index"
git add --all -- . || exit 1
git diff --cached --no-color "$base_commit" -- . ':(exclude)swebench-check.sh' > "$work/model.patch" || exit 1

if [ ! -s "$work/model.patch" ]; then
  echo "No changes against $base_commit; there is nothing to evaluate."
  exit 1
fi

tab=$(printf '\t')
cr=$(printf '\r')
patch_json=$(sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$tab/\\\\t/g" -e "s/$cr/\\\\r/g" "$work/model.patch" | awk 'BEGIN { ORS = "" } NR > 1 { printf "\\n" } { printf "%s", $0 }')
printf '[{"instance_id": "%s", "model_name_or_path": "race", "model_patch": "%s"}]\n' "$instance_id" "$patch_json" > "$work/predictions.json"

run_id="race-$(basename "$work")"
cd "$work" || exit 1
uvx --python 3.12 --from swebench==${SWEBENCH_VERSION} python -m swebench.harness.run_evaluation \
  --dataset_name ${DATASET} \
  --split test \
  --instance_ids "$instance_id" \
  --predictions_path "$work/predictions.json" \
  --max_workers 1 \
  --run_id "$run_id" \
  --cache_level env \
  --clean True
harness_status=$?

instance_logs="logs/run_evaluation/$run_id/race/$instance_id"
if [ -f "$instance_logs/report.json" ] && grep -q '"resolved": true' "$instance_logs/report.json"; then
  exit 0
fi
echo "SWE-bench did not mark $instance_id resolved (the harness exited with $harness_status)."
if [ -f "$instance_logs/test_output.txt" ]; then
  tail -n 100 "$instance_logs/test_output.txt"
elif [ -f "$instance_logs/run_instance.log" ]; then
  tail -n 100 "$instance_logs/run_instance.log"
fi
exit 1
`;

interface InstanceRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  patch: string;
  problem_statement: string;
}

export interface ImportReport {
  problems: number;
  skipped: { id: string; why: string }[];
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function rowsOf(rowsFile: string | undefined): Promise<InstanceRow[]> {
  let text: string;
  if (rowsFile === undefined) {
    const response = await fetch(ROWS_URL);
    if (!response.ok) throw new Error(`The dataset couldn't be read from Hugging Face: ${response.status} ${response.statusText}.`);
    text = await response.text();
  } else {
    text = await readFile(rowsFile, "utf8");
  }
  const parsed = JSON.parse(text) as { rows?: { row: InstanceRow }[] };
  if (!Array.isArray(parsed.rows)) throw new Error("The rows must hold the datasets-server's answer: { rows: [{ row: ... }] }.");
  return parsed.rows.map(({ row }) => row);
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

/** The instance's base commit as the start branch, fetched shallow from the upstream repository. */
async function fetchStart(setFolder: string, baseUrl: string, { repo, base_commit, instance_id }: InstanceRow) {
  await mustGit(setFolder, ["fetch", "--depth", "1", `${baseUrl}/${repo}`, base_commit]);
  await mustGit(setFolder, ["update-ref", `refs/heads/start/${instance_id}`, "FETCH_HEAD"]);
}

/** The files the gold patch changes or adds, as they are after it, applied in a worktree of the start commit. */
async function writeReference(setFolder: string, problemFolder: string, instance: InstanceRow) {
  const temp = await mkdtemp(join(tmpdir(), "swebench-reference-"));
  const worktree = join(temp, "worktree");
  try {
    await mustGit(setFolder, ["worktree", "add", "--detach", "--quiet", worktree, `start/${instance.instance_id}`]);
    const patchFile = join(temp, "gold.patch");
    await writeFile(patchFile, instance.patch);
    await mustGit(worktree, ["apply", "--whitespace=nowarn", patchFile]);
    await mustGit(worktree, ["add", "--all"]);
    const changed = (await mustGit(worktree, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"])).split("\n").filter((path) => path.length > 0);
    await Promise.all(
      changed.map(async (path) => {
        const to = join(problemFolder, "reference", path);
        await mkdir(dirname(to), { recursive: true });
        await cp(join(worktree, path), to);
      }),
    );
  } finally {
    await git(setFolder, ["worktree", "remove", "--force", worktree]);
    await rm(temp, { recursive: true, force: true });
  }
}

async function writeProblem(setFolder: string, instance: InstanceRow) {
  const { instance_id, base_commit, repo, problem_statement } = instance;
  const problemFolder = join(setFolder, "problems", instance_id);
  await rm(problemFolder, { recursive: true, force: true });
  await mkdir(join(problemFolder, "check"), { recursive: true });
  await writeFile(join(problemFolder, "problem.json"), json({ start: `start/${instance_id}`, check: `sh swebench-check.sh ${instance_id} ${base_commit}`, tags: ["swebench", repo] }));
  await writeFile(join(problemFolder, "task.md"), `${problem_statement.trim()}\n\nFix the issue above in this repository. Don't change its tests.\n`);
  await writeFile(join(problemFolder, "check", "swebench-check.sh"), SWEBENCH_CHECK);
  await writeReference(setFolder, problemFolder, instance);
}

/** Imports SWE-bench Verified Mini into a problem set: a folder per instance and its base commit as a start branch. */
export async function importSwebench(setFolder: string, { rowsFile, baseUrl = "https://github.com", limit }: { rowsFile?: string; baseUrl?: string; limit?: number } = {}): Promise<ImportReport> {
  await prepareSet(setFolder);
  const rows = await rowsOf(rowsFile);
  const report: ImportReport = { problems: 0, skipped: [] };
  const instances = (limit === undefined ? rows : rows.slice(0, limit)).filter((row) => {
    if (isProblemId(row.instance_id)) return true;
    report.skipped.push({ id: row.instance_id, why: "its instance id isn't a problem id: lower case letters, digits, dots, dashes or underscores, starting with a letter or digit." });
    return false;
  });
  for (const instance of instances) {
    await fetchStart(setFolder, baseUrl, instance);
    await writeProblem(setFolder, instance);
    report.problems++;
  }
  await writeFile(join(setFolder, "set.json"), json(SET));
  await mustGit(setFolder, ["add", "set.json", "problems"]);
  if ((await git(setFolder, ["diff", "--cached", "--quiet"])).exitCode !== 0) {
    await mustGit(setFolder, ["commit", "-m", `Import ${report.problems} SWE-bench Verified Mini problems`]);
  }
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  const positionals = args.filter((arg, at) => !arg.startsWith("--") && !["--limit", "--rows", "--base-url"].includes(args[at - 1] ?? ""));
  const [setFolder] = positionals;
  if (!setFolder) {
    console.error("Usage: bun scripts/import-swebench.ts <set folder> [--limit n] [--rows <file>] [--base-url <url>]");
    process.exit(1);
  }
  const limitText = valueOf("--limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  try {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit must be a positive whole number, not "${limitText}".`);
    const report = await importSwebench(setFolder, { rowsFile: valueOf("--rows"), baseUrl: valueOf("--base-url"), limit });
    report.skipped.forEach(({ id, why }) => console.log(`Skipped ${id}: ${why}`));
    console.log(`Imported ${report.problems} problem${report.problems === 1 ? "" : "s"} into ${setFolder}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
