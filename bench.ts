import type { RanOn } from "./mirador/api.ts";
import type { CheckResult } from "./race.ts";
import type { ProblemValidation } from "./sets.ts";

/** set.json: how a problem set's runs go. */
export interface BenchSettings {
  name: string;
  checkTimeoutMinutes: number;
  agentTimeLimitMinutes: number;
  tries: 1 | 2;
}

export const DEFAULT_SETTINGS: Omit<BenchSettings, "name"> = { checkTimeoutMinutes: 3, agentTimeLimitMinutes: 30, tries: 2 };

/** problems/<id>/problem.json, with the id its folder gives. */
export interface ProblemSpec {
  id: string;
  /** A commit of the set's repository, as a hash, branch or tag, that racers start from. */
  start: string;
  /** Run in the racer's folder once the problem's hidden check files are copied in; exit code 0 passes. */
  check: string;
  tags: string[];
}

export const isProblemId = (id: string) => /^[a-z0-9][a-z0-9._-]*$/.test(id);

export interface BenchColumn { profile: string; model: string | null; effort: string | null }

export const columnLabel = ({ profile, model, effort }: BenchColumn) => [profile, model, effort].filter(Boolean).join(" · ");

export type CellState = "waiting" | "starting" | "working" | "checking" | "retrying" | "done";
export type CellResult = "passed" | "passed on try 2" | "failed" | "timed out" | "stopped" | "agent failed" | "couldn't start";

export interface TryResult { check: CheckResult; endedAt: number }

/** Mirador's ConversationUsage (plugin API 14), copied here so this module needs no newer api.ts. */
export interface ConversationUsage {
  inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedWriteTokens: number;
  cost: { amount: number; currency: string } | null;
  turns: number;
}

/** One racer of a run: a problem, on a column, for one attempt. */
export interface BenchCell {
  problem: string;
  column: number;   // index into BenchRun.columns
  attempt: number;  // 1-based
  state: CellState;
  result: CellResult | null;
  conversationId: string | null;
  folder: string | null;
  branch: string | null;
  /** The racer's work since its problem's start, kept as a patch once its conversation and worktree are deleted. */
  patch: string | null;
  tries: TryResult[];
  startedAt: number | null;
  endedAt: number | null;
  usage: ConversationUsage | null;
  ranOn: RanOn | null;
  /** Why it couldn't start, or what else the user should know of it. */
  note: string | null;
}

export type RunPhase = "setup" | "running" | "done" | "stopped";

export interface BenchRun {
  id: string;
  set: { name: string; folder: string; commit: string | null };
  settings: BenchSettings;
  columns: BenchColumn[];
  attempts: number;
  /** How many racers of one profile work at once; a local model serves only a few. */
  atOnce: number;
  /** Delete each racer's conversation and worktree once its result is kept, keeping its changes as the cell's patch. */
  deleteRacers: boolean;
  problems: string[];
  cells: BenchCell[];
  phase: RunPhase;
  startedAt: number | null;
  endedAt: number | null;
  /** Each problem's validation, as the form's Validate problems finds them; only a setup item keeps it. */
  validation?: ProblemValidation[];
}

export const newRunId = () => crypto.randomUUID().slice(0, 6);
export const MAX_ATTEMPTS = 5;
export const MAX_AT_ONCE = 6;

export interface ColumnTotals {
  column: number;
  done: number;               // cells with a result
  passedFirstTry: number;     // result "passed"
  passed: number;             // "passed" or "passed on try 2"
  problemsSolved: number;     // problems with at least one passed cell in this column
  medianSeconds: number | null; // median of (endedAt - startedAt) / 1000 over done cells that started; null if none
  inputTokens: number; outputTokens: number;  // summed over cells' usage
  cost: { amount: number; currency: string } | null; // summed when every cell with a cost shares one currency, else null; null when none has one
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isMinutes = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const isTries = (value: unknown): value is 1 | 2 => value === 1 || value === 2;

/** set.json's settings, or why they can't be read. */
export function settingsOf(json: unknown, folderName: string): BenchSettings | string {
  if (!isObject(json)) return "set.json must hold an object.";
  const { name = folderName, checkTimeoutMinutes = DEFAULT_SETTINGS.checkTimeoutMinutes, agentTimeLimitMinutes = DEFAULT_SETTINGS.agentTimeLimitMinutes, tries = DEFAULT_SETTINGS.tries } = json;
  if (typeof name !== "string" || name.length === 0) return "set.json's name must be a non-empty string.";
  if (!isMinutes(checkTimeoutMinutes)) return "set.json's checkTimeoutMinutes must be a number of minutes above 0.";
  if (!isMinutes(agentTimeLimitMinutes)) return "set.json's agentTimeLimitMinutes must be a number of minutes above 0.";
  if (!isTries(tries)) return "set.json's tries must be 1 or 2.";
  return { name, checkTimeoutMinutes, agentTimeLimitMinutes, tries };
}

/** problem.json's spec, or why it can't be read. */
export function problemSpecOf(json: unknown, id: string): ProblemSpec | string {
  if (!isProblemId(id)) return `Problem ${id}'s folder name must be lower case letters, digits, dots, dashes or underscores.`;
  if (!isObject(json)) return "problem.json must hold an object.";
  const { start, check, tags = [] } = json;
  if (typeof start !== "string" || start.trim().length === 0) return "problem.json's start must name a commit.";
  if (typeof check !== "string" || check.trim().length === 0) return "problem.json's check must be a command.";
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || tag.length === 0)) return "problem.json's tags must be a list of words.";
  return { id, start: start.trim(), check: check.trim(), tags };
}

const waitingCell = (problem: string, column: number, attempt: number): BenchCell => ({
  problem,
  column,
  attempt,
  state: "waiting",
  result: null,
  conversationId: null,
  folder: null,
  branch: null,
  patch: null,
  tries: [],
  startedAt: null,
  endedAt: null,
  usage: null,
  ranOn: null,
  note: null,
});

/** The run's cells: problem first, then attempt, then column, so a problem's columns run side by side. */
export function cellsOf(problems: string[], columns: number, attempts: number): BenchCell[] {
  return problems.flatMap((problem) =>
    Array.from({ length: attempts }, (_, attempt) => attempt + 1).flatMap((attempt) =>
      Array.from({ length: columns }, (_, column) => waitingCell(problem, column, attempt)),
    ),
  );
}

const usesModel = ({ state }: BenchCell) => state === "starting" || state === "working" || state === "retrying";

/** The waiting cells to start now, at most `atOnce` of each profile on the model at once. */
export function cellsToStart(run: BenchRun): number[] {
  if (run.phase !== "running") return [];
  const profileOf = (cell: BenchCell) => run.columns[cell.column]!.profile;
  const busy = new Map<string, number>();
  run.cells.filter(usesModel).forEach((cell) => busy.set(profileOf(cell), (busy.get(profileOf(cell)) ?? 0) + 1));
  const picked: number[] = [];
  run.cells.forEach((cell, index) => {
    if (cell.state !== "waiting") return;
    const profile = profileOf(cell);
    const count = busy.get(profile) ?? 0;
    if (count >= run.atOnce) return;
    busy.set(profile, count + 1);
    picked.push(index);
  });
  return picked;
}

/** How a cell's tries came out, or null when it has none or a retry is due. */
export function resultOf(tries: TryResult[], triesAllowed: 1 | 2): CellResult | null {
  const last = tries.at(-1);
  if (!last) return null;
  if (tries[0]!.check.outcome === "passed") return "passed";
  if (tries[1]?.check.outcome === "passed") return "passed on try 2";
  if (last.check.outcome === "stopped") return "stopped";
  if (tries.length < triesAllowed) return null;
  return "failed";
}

export function retryPrompt(check: CheckResult): string {
  const output = check.output.trim() || "(it printed nothing)";
  return `The check failed. What it printed:

\`\`\`
${output}
\`\`\`

The tests are correct; don't change them. Fix the code so they pass, then end your turn.`;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((one, other) => one - other);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const summedCost = (cells: BenchCell[]) => {
  const costs = cells.flatMap(({ usage }) => (usage?.cost ? [usage.cost] : []));
  const [first] = costs;
  if (!first || costs.some(({ currency }) => currency !== first.currency)) return null;
  return { amount: costs.reduce((sum, { amount }) => sum + amount, 0), currency: first.currency };
};

export function totalsOf(run: BenchRun): ColumnTotals[] {
  return run.columns.map((_, column) => {
    const cells = run.cells.filter((cell) => cell.column === column);
    const done = cells.filter(({ result }) => result !== null);
    const passed = done.filter(({ result }) => result === "passed" || result === "passed on try 2");
    const durations = done
      .filter(({ startedAt, endedAt }) => startedAt !== null && endedAt !== null)
      .map(({ startedAt, endedAt }) => (endedAt! - startedAt!) / 1000);
    return {
      column,
      done: done.length,
      passedFirstTry: done.filter(({ result }) => result === "passed").length,
      passed: passed.length,
      problemsSolved: new Set(passed.map(({ problem }) => problem)).size,
      medianSeconds: median(durations),
      inputTokens: cells.reduce((sum, { usage }) => sum + (usage?.inputTokens ?? 0), 0),
      outputTokens: cells.reduce((sum, { usage }) => sum + (usage?.outputTokens ?? 0), 0),
      cost: summedCost(cells),
    };
  });
}

/** A duration in words, e.g. "41 s", "1 m 05 s", "1 h 02 m". */
export function seconds(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} m ${String(total % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

/** What the run page shows in a cell. */
export function cellWords(cell: BenchCell, now: number): string {
  const { state, result, startedAt, endedAt } = cell;
  if (state === "working") return `racing ${seconds(now - startedAt!)}`;
  if (state === "retrying") return "try 2";
  if (state !== "done") return state;
  const took = seconds(endedAt! - startedAt!);
  if (result === "passed") return `✓ ${took}`;
  if (result === "passed on try 2") return `✓ on try 2 · ${took}`;
  if (result === "failed" || result === "timed out" || result === "agent failed") return `✗ ${result}`;
  return result!;
}

/** How the run came out, in one line. */
export function runSummary(run: BenchRun): string {
  const totals = totalsOf(run);
  const columns = run.columns.map((column, index) => {
    const { passed, done, passedFirstTry } = totals[index]!;
    const onTry2 = passed - passedFirstTry;
    return `${columnLabel(column)} passed ${passed} of ${done}${onTry2 > 0 ? `, ${onTry2} on try 2` : ""}`;
  });
  return `Bench run ${run.id} on ${run.set.name}: ${columns.join("; ")}.`;
}

/** The JSON a run leaves in the set's runs/ folder. */
export function resultsFileOf(run: BenchRun, totals = totalsOf(run)) {
  const secondsOf = ({ startedAt, endedAt }: BenchCell) => (startedAt !== null && endedAt !== null ? (endedAt - startedAt) / 1000 : null);
  return {
    run: run.id,
    set: run.set.name,
    commit: run.set.commit,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    settings: run.settings,
    columns: run.columns.map((column, index) => ({
      ...column,
      ranOn: run.cells.find((cell) => cell.column === index && cell.ranOn !== null)?.ranOn ?? null,
    })),
    cells: run.cells.map((cell) => ({
      problem: cell.problem,
      column: cell.column,
      attempt: cell.attempt,
      result: cell.result,
      seconds: secondsOf(cell),
      tries: cell.tries.map(({ check }) => ({ outcome: check.outcome, exitCode: check.exitCode, seconds: check.durationMs / 1000 })),
      usage: cell.usage,
      note: cell.note,
      patch: cell.patch,
    })),
    totals,
  };
}