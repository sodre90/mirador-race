import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import host from "../host.ts";
import { BENCH_ITEM_TYPE } from "../bench-host.ts";
import { retryPrompt, runSummary, type BenchRun } from "../bench.ts";
import { fakeMirador, finished, git, PROFILES, until } from "./fake-mirador.ts";

let scratch: string;
let repo: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "bench-test-")));
  repo = join(scratch, "set");
  await mkdir(repo);
  await git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

const CHECK_SH = "grep -qx 42 answer.txt || { echo expected 42 in answer.txt; exit 1; }\n";

/** A set on main, with a start branch of its own per problem, whose answer.txt holds 0. */
async function makeSet(folder: string, problems: string[], settings: Record<string, unknown> = {}) {
  for (const id of problems) {
    await git(folder, ["checkout", "-q", "--orphan", `start/${id}`]);
    writeFileSync(join(folder, "answer.txt"), "0\n");
    await git(folder, ["add", "-A"]);
    await git(folder, ["commit", "-qm", `start ${id}`]);
  }
  await git(folder, ["checkout", "-q", "--orphan", "main"]);
  await git(folder, ["rm", "-rqf", "."]);
  writeFileSync(join(folder, "set.json"), JSON.stringify({ name: "Tiny", ...settings }));
  for (const id of problems) {
    const problem = join(folder, "problems", id);
    mkdirSync(join(problem, "check"), { recursive: true });
    writeFileSync(join(problem, "problem.json"), JSON.stringify({ start: `start/${id}`, check: "sh check.sh" }));
    writeFileSync(join(problem, "task.md"), `Solve ${id}: make the answer 42.\n`);
    writeFileSync(join(problem, "check", "check.sh"), CHECK_SH);
  }
  await git(folder, ["add", "-A"]);
  await git(folder, ["commit", "-qm", "set"]);
}

const miradorOf = (options: { caller?: "agent" | "user"; refuseProfile?: string } = {}) => fakeMirador<BenchRun>({ repo, scratch, itemType: BENCH_ITEM_TYPE, ...options });

type Mirador = ReturnType<typeof miradorOf>;

/** The 1-based racer number of a cell's conversation, as the fake's replied and heard take it; cells start in parallel, so started order isn't cell order. */
const cellRacer = (mirador: Mirador, cell: number) => mirador.started.findIndex(({ id }) => id === mirador.page().cells[cell]!.conversationId) + 1;
const cellStart = (mirador: Mirador, cell: number) => mirador.started[cellRacer(mirador, cell) - 1]!;

test("a bench run starts a racer per problem and column, each in a worktree from its problem's start, with its task word for word, at most atOnce per profile at a time", async () => {
  await makeSet(repo, ["two-fer", "bob"]);
  const mirador = miradorOf();

  const answer = await mirador.call(mirador.captain, "bench", {
    columns: [{ profile: "qwen flash" }, { profile: "Kimi", model: "opus", effort: "high" }, { profile: "Qwen Flash" }],
    atOnce: 1,
  });
  await until(() => mirador.started.length === 2, "the first cell of each profile started");

  const run = mirador.page();
  expect(answer).toBe(`Bench run ${run.id} started: 2 problems × 3 columns on Tiny. The run page shows each result as it comes.`);
  expect(run).toMatchObject({ phase: "running", attempts: 1, atOnce: 1, problems: ["bob", "two-fer"], settings: { name: "Tiny", tries: 2 } });
  expect(run.set).toEqual({ name: "Tiny", folder: repo, commit: (await git(repo, ["rev-parse", "HEAD"])).trim() });
  expect(run.columns).toEqual([
    { profile: "Qwen Flash", model: null, effort: null },
    { profile: "Kimi", model: "opus", effort: "high" },
    { profile: "Qwen Flash", model: null, effort: null },
  ]);
  expect(run.cells.map(({ problem, column, state }) => ({ problem, column, state }))).toEqual([
    { problem: "bob", column: 0, state: "working" },
    { problem: "bob", column: 1, state: "working" },
    { problem: "bob", column: 2, state: "waiting" },
    { problem: "two-fer", column: 0, state: "waiting" },
    { problem: "two-fer", column: 1, state: "waiting" },
    { problem: "two-fer", column: 2, state: "waiting" },
  ]);
  expect(mirador.started.map(({ profile }) => profile).sort()).toEqual(["Kimi", "Qwen Flash"]);
  expect(cellStart(mirador, 0).prompt).toBe("Solve bob: make the answer 42.\n");
  expect(cellStart(mirador, 0).title).toBe(`Bench ${run.id} · bob · Qwen Flash`);
  expect(cellStart(mirador, 1).prompt).toBe("Solve bob: make the answer 42.\n");
  expect(cellStart(mirador, 1).title).toBe(`Bench ${run.id} · bob · Kimi · opus · high`);
  expect(cellStart(mirador, 1).model).toBe("opus");
  expect(cellStart(mirador, 1).effort).toBe("high");
  const start = (await git(repo, ["rev-parse", "start/bob^{commit}"])).trim();
  for (const { folder } of mirador.started) expect((await git(folder, ["rev-parse", "HEAD"])).trim()).toBe(start);
  expect(mirador.items).toHaveLength(1);
  expect(mirador.raceItem().title).toBe("Bench · Tiny");
  expect(host.items[BENCH_ITEM_TYPE]!.outcome!(run)).toBe("0/6 done");

  writeFileSync(join(cellStart(mirador, 0).folder, "answer.txt"), "42\n");
  await mirador.replied(cellRacer(mirador, 0), finished("done"));
  await until(() => mirador.started.length === 3, "the next cell of that profile started");

  expect(cellStart(mirador, 2).prompt).toBe("Solve bob: make the answer 42.\n");
  expect(mirador.page().cells[2]).toMatchObject({ problem: "bob", column: 2, state: "working" });
  expect(mirador.page().cells[0]).toMatchObject({ state: "done", result: "passed" });

  writeFileSync(join(cellStart(mirador, 2).folder, "answer.txt"), "42\n");
  await mirador.replied(cellRacer(mirador, 2), finished("done"));
  await until(() => mirador.started.length === 4, "the next problem's cell of that profile started");

  expect(cellStart(mirador, 3).prompt).toBe("Solve two-fer: make the answer 42.\n");
  expect(mirador.page().cells[3]).toMatchObject({ problem: "two-fer", column: 0, state: "working" });
});

test("a run of several attempts says so in the answer it gives, and runs them one after another", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();

  const answer = await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], attempts: 2, atOnce: 1 });
  await until(() => mirador.started.length === 1, "the first attempt started");

  const run = mirador.page();
  expect(answer).toBe(`Bench run ${run.id} started: 1 problems × 1 columns × 2 attempts on Tiny. The run page shows each result as it comes.`);
  expect(run.attempts).toBe(2);
  expect(run.cells.map(({ attempt, state }) => ({ attempt, state }))).toEqual([
    { attempt: 1, state: "working" },
    { attempt: 2, state: "waiting" },
  ]);
});

test("a racer's finished work is checked with its problem's hidden files copied over its own, and passes", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => mirador.started.length === 1, "the racer started");
  const { folder } = mirador.started[0]!;
  writeFileSync(join(folder, "check.sh"), "echo the racer's own check\nexit 0\n");
  writeFileSync(join(folder, "answer.txt"), "42\n");

  await mirador.replied(1, finished("done"));

  const cell = mirador.page().cells[0]!;
  expect(cell).toMatchObject({ state: "done", result: "passed" });
  expect(cell.tries).toHaveLength(1);
  expect(cell.tries[0]!.check).toMatchObject({ outcome: "passed", exitCode: 0, output: "" });
  expect(readFileSync(join(folder, "check.sh"), "utf8")).toBe(CHECK_SH);
  expect(mirador.page().phase).toBe("done");
});

test("a failed check gives the racer a second try with what it printed, and a pass then counts as on try 2", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => mirador.started.length === 1, "the racer started");
  const racerId = mirador.started[0]!.id;

  await mirador.replied(1, finished("I think it's done."));

  let cell = mirador.page().cells[0]!;
  expect(cell.state).toBe("retrying");
  expect(cell.result).toBeNull();
  expect(cell.tries).toHaveLength(1);
  expect(cell.tries[0]!.check).toMatchObject({ outcome: "failed", exitCode: 1, output: "expected 42 in answer.txt\n" });
  const [retry] = mirador.promptsTo(racerId);
  expect(retry?.text).toBe(retryPrompt(cell.tries[0]!.check));

  await mirador.heard(1, { kind: "turn-ended", ended: "finished" });
  expect(mirador.page().cells[0]!.state, "the first turn's end isn't taken for the second's").toBe("retrying");
  expect(mirador.page().cells[0]!.tries).toHaveLength(1);

  await mirador.heard(1, { kind: "turn-started" });
  writeFileSync(join(mirador.started[0]!.folder, "answer.txt"), "42\n");
  await mirador.heard(1, { kind: "turn-ended", ended: "finished" });

  cell = mirador.page().cells[0]!;
  expect(cell).toMatchObject({ state: "done", result: "passed on try 2" });
  expect(cell.tries.map(({ check }) => check.outcome)).toEqual(["failed", "passed"]);
  expect(mirador.page().phase).toBe("done");
  expect(mirador.promptsTo(racerId)).toHaveLength(1);
});

test("with one try, a failed check fails the cell; a failed or stopped turn isn't checked", async () => {
  await makeSet(repo, ["a", "b", "c"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], tries: 1, atOnce: 3 });
  await until(() => mirador.started.length === 3, "the racers started");

  await mirador.replied(cellRacer(mirador, 0), finished("done"));
  await mirador.replied(cellRacer(mirador, 1), { text: null, ended: "failed" });
  await mirador.replied(cellRacer(mirador, 2), { text: null, ended: "stopped" });

  const run = mirador.page();
  expect(run.settings.tries).toBe(1);
  expect(run.cells.map(({ result, state }) => ({ result, state }))).toEqual([
    { result: "failed", state: "done" },
    { result: "agent failed", state: "done" },
    { result: "stopped", state: "done" },
  ]);
  expect(run.cells[0]!.tries).toHaveLength(1);
  expect(run.cells[1]!.tries).toEqual([]);
  expect(run.cells[2]!.tries).toEqual([]);
  expect(mirador.promptsTo(cellStart(mirador, 0).id), "no second try with one try").toEqual([]);
  expect(run.phase).toBe("done");
});

test("a cell that can't start says why, and the run goes on", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf({ refuseProfile: "Kimi" });
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Qwen Flash" }, { profile: "Kimi" }] });
  await until(() => mirador.page().cells[1]!.result !== null && mirador.page().cells[0]!.state === "working", "the refused cell ended and the other started");

  let run = mirador.page();
  expect(run.cells[1]).toMatchObject({ state: "done", result: "couldn't start", note: "The profile Kimi can't start a conversation now." });
  expect(run.cells[1]!.endedAt).not.toBeNull();
  expect(run.cells[0]!.state).toBe("working");
  expect(run.phase).toBe("running");

  writeFileSync(join(mirador.started[0]!.folder, "answer.txt"), "42\n");
  await mirador.replied(1, finished("done"));

  run = mirador.page();
  expect(run.phase).toBe("done");
  expect(run.cells.map(({ result }) => result)).toEqual(["passed", "couldn't start"]);
  expect(mirador.promptsTo(mirador.captain.conversationId)).toHaveLength(1);
});

test("when every cell has a result the run is over, and the captain hears the summary and to tell the user in one line", async () => {
  await makeSet(repo, ["a", "b"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi", model: "opus" }] });
  await until(() => mirador.started.length === 2, "the racers started");
  for (const { folder } of mirador.started) writeFileSync(join(folder, "answer.txt"), "42\n");
  const ranOn = { model: { id: "claude-opus-4-5", name: "Opus 4.5" }, effort: "high" };

  await mirador.replied(cellRacer(mirador, 0), { ...finished("done"), ranOn });
  expect(mirador.page().phase).toBe("running");
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
  await mirador.replied(cellRacer(mirador, 1), finished("done"));

  const run = mirador.page();
  expect(run.phase).toBe("done");
  expect(run.endedAt).not.toBeNull();
  expect(run.cells[0]!.ranOn).toEqual(ranOn);
  expect(run.cells[1]!.ranOn).toBeNull();
  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  expect(told?.afterTurn).toBe(true);
  expect(told?.text).toBe(`${runSummary(run)} Tell the user in one line that bench run ${run.id} is over; its page has every result.`);
  expect(host.items[BENCH_ITEM_TYPE]!.outcome!(run)).toBe("done");
});

test("Stop run stops the racers still working, marks the rest stopped, and tells the captain nothing", async () => {
  await makeSet(repo, ["a", "b", "c"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], atOnce: 2 });
  await until(() => mirador.started.length === 2, "the racers started");

  await mirador.replied(cellRacer(mirador, 0), finished("done"));
  expect(mirador.page().cells[0]!.state).toBe("retrying");

  expect(await mirador.act({ kind: "stop" })).toEqual({ stopped: true });

  const run = mirador.page();
  expect(run.phase).toBe("stopped");
  expect(run.endedAt).not.toBeNull();
  expect(run.cells.map(({ result, state }) => ({ result, state }))).toEqual([
    { result: "stopped", state: "done" },
    { result: "stopped", state: "done" },
    { result: "stopped", state: "done" },
  ]);
  expect(mirador.stopped).toEqual([cellStart(mirador, 0).id, cellStart(mirador, 1).id]);
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
  expect(host.items[BENCH_ITEM_TYPE]!.outcome!(run)).toBe("stopped");

  await mirador.replied(cellRacer(mirador, 1), { text: null, ended: "stopped" });
  expect(mirador.page().cells[1]!.result).toBe("stopped");
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
});

test("an agent's call only drafts the run on a form, filled in with what it asked, and starts nothing; the user's /race:bench without columns gets an empty form; a workspace that isn't a set is refused saying why; unknown profiles and problems are refused, from the agent too", async () => {
  await makeSet(repo, ["two-fer", "bob"]);
  const agent = miradorOf({ caller: "agent" });

  const answer = await agent.call(agent.captain, "bench", { columns: [{ profile: "kimi", model: "opus" }], attempts: 2, atOnce: 3, problems: ["two-fer"], tries: 1 });

  expect(answer).toBe("Bench run drafted on the canvas: the user checks it and presses Start run. You hear the results as your next message once it's over.");
  expect(agent.started).toEqual([]);
  expect(agent.raceItem().title).toBe("New bench run");
  const draft = agent.page();
  expect(draft).toMatchObject({
    phase: "setup",
    set: { name: "Tiny", folder: repo, commit: (await git(repo, ["rev-parse", "HEAD"])).trim() },
    settings: { name: "Tiny", tries: 1 },
    columns: [{ profile: "Kimi", model: "opus", effort: null }],
    attempts: 2,
    atOnce: 3,
    problems: ["two-fer"],
    cells: [],
    startedAt: null,
    endedAt: null,
  });
  expect(host.items[BENCH_ITEM_TYPE]!.outcome!(draft)).toBe("new");

  const user = miradorOf();
  expect(await user.call(user.captain, "bench", {})).toBe("Choose the columns on the canvas, then press Start run.");
  expect(user.started).toEqual([]);
  expect(user.page()).toMatchObject({ phase: "setup", columns: [], attempts: 1, atOnce: 2, problems: [], settings: { name: "Tiny", tries: 2 }, cells: [], startedAt: null });

  const plain = join(scratch, "plain");
  await mkdir(plain);
  await git(plain, ["-c", "init.defaultBranch=main", "init", "-q"]);
  writeFileSync(join(plain, "app.ts"), "export const answer = 1;\n");
  await git(plain, ["add", "-A"]);
  await git(plain, ["commit", "-qm", "base"]);
  const outsider = fakeMirador<BenchRun>({ repo: plain, scratch, itemType: BENCH_ITEM_TYPE });
  await expect(outsider.call(outsider.captain, "bench", { columns: [{ profile: "Kimi" }] })).rejects.toThrow(`${plain} isn't a problem set: it has no set.json.`);
  expect(outsider.items).toEqual([]);

  await expect(agent.call(agent.captain, "bench", { columns: [{ profile: "Opus" }] })).rejects.toThrow("There is no profile named Opus.");
  await expect(agent.call(agent.captain, "bench", { columns: [{ profile: "Kimi" }], problems: ["ghost"] })).rejects.toThrow("The set has no problem ghost.");
  await expect(user.call(user.captain, "bench", { columns: [{ profile: "Opus" }] })).rejects.toThrow("There is no profile named Opus.");
  await expect(user.call(user.captain, "bench", { columns: [{ profile: "Kimi" }], problems: ["ghost"] })).rejects.toThrow("The set has no problem ghost.");
  expect(agent.items).toHaveLength(1);
  expect(user.items).toHaveLength(1);
  expect(agent.started).toEqual([]);
  expect(user.started).toEqual([]);
});

test("the form starts its run on its own page, once", async () => {
  await makeSet(repo, ["two-fer", "bob"]);
  const mirador = miradorOf({ caller: "agent" });
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "kimi" }] });
  const formId = mirador.page().id;

  expect(await mirador.act({ kind: "profiles" })).toEqual(PROFILES);
  expect(await mirador.act({ kind: "set" })).toEqual({
    name: "Tiny",
    problems: [{ id: "bob", tags: [] }, { id: "two-fer", tags: [] }],
    problemsLeftOut: [],
    settings: { name: "Tiny", checkTimeoutMinutes: 3, agentTimeLimitMinutes: 30, tries: 2 },
  });
  await expect(mirador.act({ kind: "start", columns: [{ profile: "Opus" }] })).rejects.toThrow("There is no profile named Opus.");
  await expect(mirador.act({ kind: "start", columns: [] })).rejects.toThrow("A run has 1 to 6 columns.");

  expect(await mirador.act({ kind: "start", columns: [{ profile: "Kimi" }], attempts: 1, tries: 2, atOnce: 2, problems: [] })).toEqual({ started: formId });
  await until(() => mirador.started.length === 2, "the racers started");

  expect(mirador.items).toHaveLength(1);
  expect(mirador.raceItem().title).toBe("Bench · Tiny");
  expect(mirador.page()).toMatchObject({ id: formId, phase: "running", problems: ["bob", "two-fer"] });
  expect(mirador.started.map(({ title }) => title).sort()).toEqual([`Bench ${formId} · bob · Kimi`, `Bench ${formId} · two-fer · Kimi`]);
  await expect(mirador.act({ kind: "start", columns: [{ profile: "Kimi" }] })).rejects.toThrow("This run has started already.");
  await expect(mirador.act({ kind: "whatever" })).rejects.toThrow("A run's page starts and stops its run and shows a racer's changes.");
});

test("a run's page shows a racer's changes since its problem's start", async () => {
  await makeSet(repo, ["a", "b"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], atOnce: 1 });
  await until(() => mirador.started.length === 1, "the racer started");
  const { folder } = mirador.started[0]!;
  writeFileSync(join(folder, "answer.txt"), "42\n");
  await git(folder, ["commit", "-qam", "answer"]);
  writeFileSync(join(folder, "notes.md"), "how I solved it\n");

  const { diff } = (await mirador.act({ kind: "diff", cell: 0 })) as { diff: string };

  expect(diff).toContain("-0\n");
  expect(diff).toContain("+42\n");
  expect(diff).toContain("+++ b/notes.md");
  expect(diff).not.toContain("set.json");
  expect(await mirador.act({ kind: "diff", cell: 1 })).toEqual({ diff: "This racer hasn't started yet; look again in a minute." });
  await expect(mirador.act({ kind: "diff", cell: 9 })).rejects.toThrow("has no cell 9");

  await mirador.replied(1, finished("done"));
  await until(() => mirador.started.length === 2, "the next racer started");
  expect(await mirador.act({ kind: "diff", cell: 1 })).toEqual({ diff: "This racer hasn't changed anything yet." });
});