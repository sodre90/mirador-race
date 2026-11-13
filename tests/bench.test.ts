import { expect, test } from "bun:test";
import {
  cellsOf,
  cellsToStart,
  cellWords,
  DEFAULT_SETTINGS,
  leaderboardOf,
  problemSpecOf,
  resultOf,
  resultsFileOf,
  retryPrompt,
  runSummary,
  settingsOf,
  totalsOf,
  type BenchCell,
  type BenchColumn,
  type BenchRun,
  type CellResult,
  type ConversationUsage,
  type TryResult,
} from "../bench.ts";
import type { CheckOutcome, CheckResult } from "../race.ts";
import type { RanOn } from "../mirador/api.ts";

const column = (profile: string, model: string | null = null, effort: string | null = null): BenchColumn => ({ profile, model, effort });

const cellOf = (overrides: Partial<BenchCell> = {}): BenchCell => ({
  problem: "two-fer",
  column: 0,
  attempt: 1,
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
  ...overrides,
});

function runOf(columns: BenchColumn[], cells: BenchCell[], overrides: Partial<BenchRun> = {}): BenchRun {
  return {
    id: "a1b2c3",
    set: { name: "Tiny", folder: "/sets/tiny", commit: "abc123" },
    settings: { name: "Tiny", ...DEFAULT_SETTINGS },
    columns,
    attempts: 1,
    atOnce: 1,
    deleteRacers: false,
    problems: [...new Set(cells.map(({ problem }) => problem))],
    cells,
    phase: "running",
    startedAt: 0,
    endedAt: null,
    ...overrides,
  };
}

const checkOf = (outcome: CheckOutcome): CheckResult => ({ outcome, exitCode: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null, durationMs: 1_000, output: "" });
const tryOf = (outcome: CheckOutcome): TryResult => ({ check: checkOf(outcome), endedAt: 0 });
const usageOf = (inputTokens: number, outputTokens: number, amount: number, currency = "USD"): ConversationUsage => ({
  inputTokens,
  outputTokens,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  cost: { amount, currency },
  turns: 1,
});

test("settingsOf fills in the defaults, with the name from the folder", () => {
  expect(settingsOf({}, "tiny")).toEqual({ name: "tiny", checkTimeoutMinutes: 3, agentTimeLimitMinutes: 30, tries: 2 });
});

test("settingsOf takes every field given, and ignores ones it doesn't know", () => {
  expect(settingsOf({ name: "Tiny", checkTimeoutMinutes: 5, agentTimeLimitMinutes: 60, tries: 1, extra: true }, "tiny")).toEqual({
    name: "Tiny",
    checkTimeoutMinutes: 5,
    agentTimeLimitMinutes: 60,
    tries: 1,
  });
});

test("settingsOf says what each bad field must be", () => {
  expect(settingsOf({ name: "" }, "tiny")).toBe("set.json's name must be a non-empty string.");
  expect(settingsOf({ tries: 3 }, "tiny")).toBe("set.json's tries must be 1 or 2.");
  expect(settingsOf({ checkTimeoutMinutes: 0 }, "tiny")).toBe("set.json's checkTimeoutMinutes must be a number of minutes above 0.");
  expect(settingsOf([], "tiny")).toBe("set.json must hold an object.");
  expect(settingsOf(null, "tiny")).toBe("set.json must hold an object.");
});

test("problemSpecOf reads a problem, trimmed, with tags defaulting to none", () => {
  expect(problemSpecOf({ start: " main ", check: " bun test " }, "two-fer")).toEqual({ id: "two-fer", start: "main", check: "bun test", tags: [] });
  expect(problemSpecOf({ start: "main", check: "bun test", tags: ["strings"] }, "two-fer")).toEqual({ id: "two-fer", start: "main", check: "bun test", tags: ["strings"] });
});

test("problemSpecOf says why a problem can't be read", () => {
  expect(problemSpecOf({ start: "main", check: "bun test" }, "Two Fer")).toBe("Problem Two Fer's folder name must be lower case letters, digits, dots, dashes or underscores.");
  expect(problemSpecOf({ check: "bun test" }, "two-fer")).toBe("problem.json's start must name a commit.");
  expect(problemSpecOf({ start: "main" }, "two-fer")).toBe("problem.json's check must be a command.");
  expect(problemSpecOf({ start: "main", check: "bun test", tags: [1] }, "two-fer")).toBe("problem.json's tags must be a list of words.");
});

test("cellsOf lays out one waiting cell per problem, attempt and column, a problem's columns side by side", () => {
  const cells = cellsOf(["two-fer", "bob"], 2, 2);

  expect(cells.map(({ problem, attempt, column }) => ({ problem, attempt, column }))).toEqual([
    { problem: "two-fer", attempt: 1, column: 0 },
    { problem: "two-fer", attempt: 1, column: 1 },
    { problem: "two-fer", attempt: 2, column: 0 },
    { problem: "two-fer", attempt: 2, column: 1 },
    { problem: "bob", attempt: 1, column: 0 },
    { problem: "bob", attempt: 1, column: 1 },
    { problem: "bob", attempt: 2, column: 0 },
    { problem: "bob", attempt: 2, column: 1 },
  ]);
  expect(cells[0]).toEqual(cellOf());
});

test("cellsToStart starts one cell of each profile when the columns are on different profiles", () => {
  const run = runOf([column("racer"), column("Kimi", "opus")], cellsOf(["two-fer"], 2, 1));

  expect(cellsToStart(run)).toEqual([0, 1]);
});

test("cellsToStart starts one cell between two columns of the same profile", () => {
  const run = runOf([column("racer"), column("racer", "opus")], cellsOf(["two-fer"], 2, 1));

  expect(cellsToStart(run)).toEqual([0]);
});

test("cellsToStart lets the next cell start while one is checking, but not while it works", () => {
  const cells = cellsOf(["two-fer"], 2, 1);
  cells[0]!.state = "checking";
  const run = runOf([column("racer"), column("racer")], cells);

  expect(cellsToStart(run)).toEqual([1]);
  cells[0]!.state = "working";
  expect(cellsToStart(run)).toEqual([]);
});

test("cellsToStart starts nothing unless the run is running", () => {
  const run = runOf([column("racer")], cellsOf(["two-fer"], 1, 1));

  for (const phase of ["setup", "done", "stopped"] as const) expect(cellsToStart({ ...run, phase })).toEqual([]);
});

test("resultOf scores the tries: a pass on try 1 or 2, a stop, a retry due, or a failure", () => {
  expect(resultOf([], 1)).toBeNull();
  expect(resultOf([], 2)).toBeNull();
  expect(resultOf([tryOf("passed")], 1)).toBe("passed");
  expect(resultOf([tryOf("passed")], 2)).toBe("passed");
  expect(resultOf([tryOf("failed"), tryOf("passed")], 1)).toBe("passed on try 2");
  expect(resultOf([tryOf("failed"), tryOf("passed")], 2)).toBe("passed on try 2");
  expect(resultOf([tryOf("stopped")], 1)).toBe("stopped");
  expect(resultOf([tryOf("stopped")], 2)).toBe("stopped");
  expect(resultOf([tryOf("failed"), tryOf("stopped")], 2)).toBe("stopped");
  expect(resultOf([tryOf("failed")], 2)).toBeNull();
  expect(resultOf([tryOf("timed out")], 2)).toBeNull();
  expect(resultOf([tryOf("failed")], 1)).toBe("failed");
  expect(resultOf([tryOf("timed out")], 1)).toBe("failed");
  expect(resultOf([tryOf("failed"), tryOf("failed")], 2)).toBe("failed");
  expect(resultOf([tryOf("failed"), tryOf("timed out")], 2)).toBe("failed");
});

test("retryPrompt gives the check's output, or says it printed nothing, and tells the racer to fix the code", () => {
  expect(retryPrompt({ ...checkOf("failed"), output: "  expected 42, got 1\n" })).toBe(`The check failed. What it printed:

\`\`\`
expected 42, got 1
\`\`\`

The tests are correct; don't change them. Fix the code so they pass, then end your turn.`);
  expect(retryPrompt({ ...checkOf("failed"), output: " \n " })).toBe(`The check failed. What it printed:

\`\`\`
(it printed nothing)
\`\`\`

The tests are correct; don't change them. Fix the code so they pass, then end your turn.`);
});

test("totalsOf counts a column's passes, problems, median time, tokens and cost", () => {
  const cells = [
    cellOf({ problem: "two-fer", state: "done", result: "passed", startedAt: 0, endedAt: 40_000, usage: usageOf(100, 50, 0.5) }),
    cellOf({ problem: "bob", state: "done", result: "passed on try 2", startedAt: 0, endedAt: 80_000, usage: usageOf(200, 100, 0.25) }),
    cellOf({ problem: "leap", state: "done", result: "failed", endedAt: 10_000 }),
    cellOf({ problem: "robot", state: "done", result: "timed out", startedAt: 0, endedAt: 120_000 }),
    cellOf({ problem: "grains", state: "done", result: "failed", startedAt: 0, endedAt: 60_000 }),
  ];
  const run = runOf([column("racer"), column("Kimi")], cells);

  expect(totalsOf(run)).toEqual([
    { column: 0, done: 5, passedFirstTry: 1, passed: 2, problemsSolved: 2, medianSeconds: 70, inputTokens: 300, outputTokens: 150, cost: { amount: 0.75, currency: "USD" } },
    { column: 1, done: 0, passedFirstTry: 0, passed: 0, problemsSolved: 0, medianSeconds: null, inputTokens: 0, outputTokens: 0, cost: null },
  ]);
});

test("totalsOf gives no cost when the cells' currencies differ", () => {
  const cells = [
    cellOf({ state: "done", result: "passed", usage: usageOf(100, 50, 0.5, "USD") }),
    cellOf({ problem: "bob", state: "done", result: "passed", usage: usageOf(100, 50, 0.5, "EUR") }),
  ];

  expect(totalsOf(runOf([column("racer")], cells))[0]!.cost).toBeNull();
});

test("cellWords says what each cell shows, with its time once it has one", () => {
  const now = 100_000;
  const words = (overrides: Partial<BenchCell>) => cellWords(cellOf(overrides), now);

  expect(words({})).toBe("waiting");
  expect(words({ state: "starting" })).toBe("starting");
  expect(words({ state: "working", startedAt: 59_000 })).toBe("racing 41 s");
  expect(words({ state: "checking" })).toBe("checking");
  expect(words({ state: "retrying" })).toBe("try 2");
  expect(words({ state: "done", result: "passed", startedAt: 0, endedAt: 65_000 })).toBe("✓ 1 m 05 s");
  expect(words({ state: "done", result: "passed on try 2", startedAt: 0, endedAt: 3_720_000 })).toBe("✓ on try 2 · 1 h 02 m");
  expect(words({ state: "done", result: "failed", startedAt: 0, endedAt: 65_000 })).toBe("✗ failed");
  expect(words({ state: "done", result: "timed out", startedAt: 0, endedAt: 65_000 })).toBe("✗ timed out");
  expect(words({ state: "done", result: "stopped", startedAt: 0, endedAt: 65_000 })).toBe("stopped");
  expect(words({ state: "done", result: "agent failed", startedAt: 0, endedAt: 65_000 })).toBe("✗ agent failed");
  expect(words({ state: "done", result: "couldn't start" })).toBe("couldn't start");
});

test("runSummary says each column's passes in a line, with the passes on try 2", () => {
  const cells = [
    cellOf({ problem: "two-fer", column: 0, state: "done", result: "passed" }),
    cellOf({ problem: "bob", column: 0, state: "done", result: "failed" }),
    cellOf({ problem: "two-fer", column: 1, state: "done", result: "passed" }),
    cellOf({ problem: "bob", column: 1, state: "done", result: "passed on try 2" }),
  ];
  const run = runOf([column("racer"), column("Kimi", "opus")], cells);

  expect(runSummary(run)).toBe("Bench run a1b2c3 on Tiny: racer passed 1 of 2; Kimi · opus passed 2 of 2, 1 on try 2.");
});

test("resultsFileOf leaves the run's shape, each column's ranOn from its first cell that has one", () => {
  const ranOn: RanOn = { model: { id: "claude-opus-4-5", name: "Opus 4.5" }, effort: "high" };
  const local: RanOn = { model: { id: "qwen3", name: "Qwen3" }, effort: null };
  const usage = usageOf(100, 50, 0.5);
  const cells = [
    cellOf({ column: 0, attempt: 1 }),
    cellOf({ column: 1, attempt: 1, state: "done", result: "passed", startedAt: 0, endedAt: 65_000, tries: [tryOf("passed")], usage, ranOn, patch: "the racer's change" }),
    cellOf({ column: 0, attempt: 2, state: "done", result: "failed", startedAt: 0, endedAt: 30_000, tries: [tryOf("failed")], ranOn: local, note: "the check couldn't start" }),
    cellOf({ column: 1, attempt: 2, state: "starting", startedAt: 50_000 }),
  ];
  const run = runOf([column("racer"), column("Kimi", "opus")], cells, { attempts: 2 });

  expect(resultsFileOf(run)).toEqual({
    run: "a1b2c3",
    set: "Tiny",
    commit: "abc123",
    startedAt: 0,
    endedAt: null,
    settings: run.settings,
    columns: [
      { profile: "racer", model: null, effort: null, ranOn: local },
      { profile: "Kimi", model: "opus", effort: null, ranOn },
    ],
    cells: [
      { problem: "two-fer", column: 0, attempt: 1, result: null, seconds: null, tries: [], usage: null, note: null, patch: null },
      { problem: "two-fer", column: 1, attempt: 1, result: "passed", seconds: 65, tries: [{ outcome: "passed", exitCode: 0, seconds: 1 }], usage, note: null, patch: "the racer's change" },
      { problem: "two-fer", column: 0, attempt: 2, result: "failed", seconds: 30, tries: [{ outcome: "failed", exitCode: 1, seconds: 1 }], usage: null, note: "the check couldn't start", patch: null },
      { problem: "two-fer", column: 1, attempt: 2, result: null, seconds: null, tries: [], usage: null, note: null, patch: null },
    ],
    totals: totalsOf(run),
  });
  expect(resultsFileOf(run, []).totals).toEqual([]);
});

const resultsOf = (columns: BenchColumn[], cells: BenchCell[], overrides: Partial<BenchRun> = {}) => resultsFileOf(runOf(columns, cells, overrides));

const scored = (problem: string, column: number, result: CellResult, endedAt = 40_000, usage: ConversationUsage | null = null): BenchCell =>
  cellOf({ problem, column, state: "done", result, startedAt: 0, endedAt, usage });

test("leaderboardOf ranks each model from its latest run, a model new in the second run with no change", () => {
  const first = resultsOf(
    [column("racer"), column("Kimi", "opus")],
    [scored("two-fer", 0, "passed"), scored("bob", 0, "failed", 80_000), scored("two-fer", 1, "passed"), scored("bob", 1, "passed", 80_000)],
    { id: "first", startedAt: 1_000 },
  );
  const second = resultsOf(
    [column("racer"), column("Fresh")],
    [scored("two-fer", 0, "passed"), scored("bob", 0, "passed", 80_000), scored("two-fer", 1, "passed"), scored("bob", 1, "failed", 80_000)],
    { id: "second", startedAt: 2_000 },
  );

  const rows = leaderboardOf([first, second]);
  const row = (label: string) => rows.find((each) => each.label === label)!;

  expect(row("racer")).toMatchObject({ runs: 2, passed: 2, done: 2, passRate: 1, change: 0.5, sameProblems: true });
  expect(row("Kimi · opus")).toMatchObject({ runs: 1, passRate: 1, change: null, sameProblems: true });
  expect(row("Fresh")).toMatchObject({ runs: 1, passRate: 0.5, change: null, sameProblems: true });
});

test("leaderboardOf keys a column by its ranOn model when it has one, else its profile, so the two never merge", () => {
  const opus: RanOn = { model: { id: "opus", name: "Opus" }, effort: "high" };
  const qwen: RanOn = { model: { id: "qwen3", name: "Qwen3" }, effort: null };
  const results = resultsOf(
    [column("Kimi", "opus"), column("Qwen Flash"), column("Qwen3")],
    [
      cellOf({ problem: "two-fer", column: 0, state: "done", result: "passed", ranOn: opus }),
      cellOf({ problem: "two-fer", column: 1, state: "done", result: "passed", ranOn: qwen }),
      cellOf({ problem: "two-fer", column: 2, state: "done", result: "failed" }),
    ],
  );

  const rows = leaderboardOf([results]);

  expect(rows).toHaveLength(3);
  expect(rows.map(({ label }) => label).sort()).toEqual(["Opus · high", "Qwen3", "Qwen3"]);
});

test("leaderboardOf adds up the columns of one run that share a model, by profile or by ranOn", () => {
  const opus: RanOn = { model: { id: "opus", name: "Opus" }, effort: null };
  const results = resultsOf(
    [column("racer"), column("racer"), column("Kimi"), column("Qwen Flash")],
    [
      scored("two-fer", 0, "passed", 40_000, usageOf(100, 50, 0.5)),
      scored("bob", 1, "failed", 80_000, usageOf(200, 100, 0.25)),
      cellOf({ problem: "two-fer", column: 2, state: "done", result: "passed", startedAt: 0, endedAt: 20_000, usage: usageOf(10, 5, 0.125), ranOn: opus }),
      cellOf({ problem: "bob", column: 3, state: "done", result: "passed on try 2", startedAt: 0, endedAt: 60_000, usage: usageOf(20, 10, 0.25), ranOn: opus }),
    ],
  );

  const rows = leaderboardOf([results]);
  const row = (label: string) => rows.find((each) => each.label === label)!;

  expect(rows).toHaveLength(2);
  expect(row("racer")).toMatchObject({ runs: 1, passed: 1, passedOnTry2: 0, done: 2, passRate: 0.5, medianSeconds: 60, tokens: 450, cost: { amount: 0.75, currency: "USD" } });
  expect(row("Opus")).toMatchObject({ runs: 1, passed: 2, passedOnTry2: 1, done: 2, passRate: 1, medianSeconds: 40, tokens: 45, cost: { amount: 0.375, currency: "USD" } });
});

test("leaderboardOf compares only runs of the same problems, and marks a row whose latest run is of other problems", () => {
  const first = resultsOf([column("racer")], [scored("two-fer", 0, "passed"), scored("bob", 0, "failed", 80_000)], { id: "first", startedAt: 1_000 });
  const other = resultsOf(
    [column("racer"), column("leaper")],
    [scored("leap", 0, "failed"), scored("leap", 1, "passed")],
    { id: "other", startedAt: 2_000 },
  );
  const newest = resultsOf([column("racer")], [scored("two-fer", 0, "passed"), scored("bob", 0, "passed", 80_000)], { id: "newest", startedAt: 3_000 });

  const rows = leaderboardOf([first, other, newest]);
  const row = (label: string) => rows.find((each) => each.label === label)!;

  expect(row("racer")).toMatchObject({ runs: 3, passRate: 1, change: 0.5, sameProblems: true });
  expect(row("leaper")).toMatchObject({ runs: 1, passRate: 1, change: null, sameProblems: false });
});

test("leaderboardOf leaves out runs of another set", () => {
  const other = resultsOf(
    [column("racer"), column("OnlyOther")],
    [scored("two-fer", 0, "passed"), scored("two-fer", 1, "passed")],
    { id: "other", startedAt: 1_000, set: { name: "Other", folder: "/sets/other", commit: null } },
  );
  const tiny = resultsOf([column("racer")], [scored("two-fer", 0, "failed")], { id: "tiny", startedAt: 2_000 });

  const rows = leaderboardOf([other, tiny]);

  expect(rows.map(({ label }) => label)).toEqual(["racer"]);
  expect(rows[0]).toMatchObject({ runs: 1, passed: 0, done: 1, passRate: 0 });
});

test("leaderboardOf sorts by pass rate, null last, then fewer tokens, then label", () => {
  const results = resultsOf(
    [column("high"), column("low"), column("none"), column("tie-b"), column("tie-a")],
    [
      scored("p", 0, "passed", 40_000, usageOf(400, 100, 0)),
      scored("p", 1, "failed", 40_000, usageOf(10, 10, 0)),
      cellOf({ problem: "p", column: 2 }),
      scored("p", 3, "passed", 40_000, usageOf(50, 50, 0)),
      scored("p", 4, "passed", 40_000, usageOf(50, 50, 0)),
    ],
  );

  expect(leaderboardOf([results]).map(({ label }) => label)).toEqual(["tie-a", "tie-b", "high", "low", "none"]);
});

test("leaderboardOf gives no rows for no results", () => {
  expect(leaderboardOf([])).toEqual([]);
});