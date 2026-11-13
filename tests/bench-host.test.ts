import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import host from "../host.ts";
import { BENCH_ITEM_TYPE } from "../bench-host.ts";
import { resultsFileOf, retryPrompt, runSummary, type BenchRun, type LeaderboardRow } from "../bench.ts";
import { DIFF_LIMIT } from "../race.ts";
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

const miradorOf = (options: { caller?: "agent" | "user"; refuseProfile?: string; refuseDelete?: (conversationId: string) => boolean } = {}) => fakeMirador<BenchRun>({ repo, scratch, itemType: BENCH_ITEM_TYPE, ...options });

type Mirador = ReturnType<typeof miradorOf>;

/** The 1-based racer number of a cell's conversation, as the fake's replied and heard take it; cells start in parallel, so started order isn't cell order. */
const cellRacer = (mirador: Mirador, cell: number) => mirador.started.findIndex(({ id }) => id === mirador.page().cells[cell]!.conversationId) + 1;
const cellStart = (mirador: Mirador, cell: number) => mirador.started[cellRacer(mirador, cell) - 1]!;

const resultsName = (run: BenchRun) => {
  const started = new Date(run.startedAt!);
  return `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, "0")}-${String(started.getDate()).padStart(2, "0")}-${run.id}.json`;
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const leftoverCheck = () => {
  const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return { pid: child.pid, startedAt: Date.now() };
};

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
  expect(answer).toBe(`Bench run ${run.id} started: 1 problem × 1 column × 2 attempts on Tiny. The run page shows each result as it comes.`);
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
  expect(told?.text).toBe(`${runSummary(run)} The results are also in runs/${resultsName(run)}. Tell the user in one line that bench run ${run.id} is over; its page has every result.`);
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

/** Holds back the starts of the racers whose title `toHold` matches until `letThrough`; `held` counts the starts waiting. */
function holdStarts(mirador: Mirador, toHold: (title: string) => boolean) {
  const startConversation = mirador.captain.startConversation;
  const hold = { held: 0, letThrough: () => {} };
  const through = new Promise<void>((resolve) => (hold.letThrough = resolve));
  mirador.captain.startConversation = async (request) => {
    if (toHold(request.title ?? "")) {
      hold.held++;
      await through;
    }
    return startConversation(request);
  };
  return hold;
}

test("Stop run while a racer starts leaves its cell stopped and stops the conversation it gets", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();
  const start = holdStarts(mirador, () => true);
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => start.held === 1, "the racer is starting");

  expect(await mirador.act({ kind: "stop" })).toEqual({ stopped: true });
  start.letThrough();
  await until(() => mirador.stopped.length === 1, "the racer that started late stopped");

  const late = mirador.started[0]!;
  expect(mirador.page().cells[0], "the cell keeps the late racer, for its page and its cleanup").toMatchObject({ state: "done", result: "stopped", conversationId: late.id, folder: late.folder, branch: late.branch, startedAt: null });
  expect(mirador.stopped).toEqual([late.id]);
});

test("a resume with no restart before it, as when the run's page loads again, leaves racers starting or on their second try going", async () => {
  await makeSet(repo, ["a", "b"]);
  const mirador = miradorOf();
  const bStart = holdStarts(mirador, (title) => title.includes(" · b · "));
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], atOnce: 2 });
  await until(() => mirador.page().cells[0]!.state === "working" && bStart.held === 1, "a's racer works and b's is starting");
  await mirador.replied(1, finished("done"));
  expect(mirador.page().cells[0]!.state).toBe("retrying");

  expect(await mirador.act({ kind: "resume" })).toEqual({ resuming: true });
  await Bun.sleep(50);
  expect(mirador.page().cells.map(({ state, result }) => ({ state, result }))).toEqual([
    { state: "retrying", result: null },
    { state: "starting", result: null },
  ]);

  bStart.letThrough();
  await until(() => mirador.page().cells[1]!.state === "working", "b's racer works");
  expect(mirador.page().cells[0]!.state).toBe("retrying");
  expect(mirador.stopped).toEqual([]);
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

test("validate checks every problem of the set one after another, and the form keeps the results until the run starts", async () => {
  await makeSet(repo, ["valid", "passes"]);
  mkdirSync(join(repo, "problems", "valid", "reference"), { recursive: true });
  writeFileSync(join(repo, "problems", "valid", "reference", "answer.txt"), "42\n");
  writeFileSync(join(repo, "problems", "passes", "check", "check.sh"), "echo already right\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "a reference and a check that passes on its start"]);
  const mirador = miradorOf({ caller: "agent" });
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });

  expect(await mirador.act({ kind: "validate" })).toEqual({ validating: true });
  await expect(mirador.act({ kind: "validate" })).rejects.toThrow("The set is being validated already.");
  await until(() => mirador.page().validation?.length === 2, "both problems validated");

  expect(mirador.page().phase).toBe("setup");
  expect(mirador.page().validation).toEqual([
    { problem: "passes", validation: "passes on its start", output: "already right\n" },
    { problem: "valid", validation: "valid", output: "" },
  ]);

  await mirador.act({ kind: "start", columns: [{ profile: "Kimi" }] });
  await until(() => mirador.started.length === 2, "the racers started");
  expect(mirador.page().validation, "a started run keeps no validation").toBeUndefined();
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

test("a racer past the set's time limit is stopped, and its cell timed out", async () => {
  await makeSet(repo, ["answer"], { agentTimeLimitMinutes: 0.001 });
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => mirador.page().cells[0]!.result === "timed out", "the cell timed out");

  expect(mirador.page().cells[0]).toMatchObject({ state: "done", result: "timed out", note: "It ran past the set's time limit of 0.001 minutes." });
  expect(mirador.stopped).toEqual([mirador.started[0]!.id]);
  expect(mirador.page().phase).toBe("done");

  await mirador.replied(1, { text: null, ended: "stopped" });
  expect(mirador.page().cells[0]!.result, "the stopped reply doesn't change the result").toBe("timed out");
});

test("with deleteRacers, a racer past the set's time limit is deleted rather than only stopped, keeping its changes", async () => {
  await makeSet(repo, ["answer"], { agentTimeLimitMinutes: 0.001 });
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], deleteRacers: true });
  await until(() => mirador.page().cells[0]!.result === "timed out", "the cell timed out");
  await until(() => mirador.deleted.length === 1, "the racer was deleted");

  expect(mirador.deleted).toEqual([mirador.started[0]!.id]);
  expect(mirador.stopped).toEqual([]);
  expect(mirador.page().cells[0]).toMatchObject({ state: "done", result: "timed out", conversationId: null, folder: null, branch: null, patch: "" });
});

test("a finished cell records its conversation's tokens and cost", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => mirador.started.length === 1, "the racer started");
  writeFileSync(join(mirador.started[0]!.folder, "answer.txt"), "42\n");

  await mirador.replied(1, finished("done"));

  expect(mirador.page().cells[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedWriteTokens: 5, cost: { amount: 0.25, currency: "USD" }, turns: 1 });
});

test("a run Mirador restarted during carries on once its page shows", async () => {
  await makeSet(repo, ["a", "b", "c", "d", "e"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], atOnce: 3 });
  await until(() => mirador.started.length === 3, "the first cells started");
  const id = mirador.page().id;
  const kept = mirador.captain.storage.get(`bench:${id}`) as { run: BenchRun };
  writeFileSync(join(kept.run.cells[0]!.folder!, "answer.txt"), "42\n");
  kept.run.cells[0]!.state = "checking";
  kept.run.cells[1]!.state = "retrying";
  kept.run.cells[3]!.state = "starting";
  mirador.captain.storage.set(`bench:${id}`, kept);
  const leftover = leftoverCheck();
  mirador.captain.storage.set(`bench-check:${id}:0`, leftover);

  expect(await mirador.act({ kind: "resume" })).toEqual({ resuming: true });
  await mirador.act({ kind: "resume" });
  await until(() => [0, 1, 3].every((cell) => mirador.page().cells[cell]!.result !== null) && mirador.page().cells[4]!.state === "working", "the cut-short cell checked, the interrupted cells ended and the waiting cell started");

  expect(isAlive(leftover.pid), "what was left of the old check").toBe(false);
  const run = mirador.page();
  expect(run.cells[0]).toMatchObject({ state: "done", result: "passed" });
  expect(run.cells[0]!.tries, "the cut-short check ran once").toHaveLength(1);
  expect(run.cells[1]).toMatchObject({ state: "done", result: "failed", note: "Mirador restarted during its second try." });
  expect(run.cells[2]!.state, "the working cell keeps working").toBe("working");
  expect(run.cells[3]).toMatchObject({ state: "done", result: "couldn't start", note: "Mirador restarted as it started." });
  expect(mirador.captain.storage.get(`bench-check:${id}:0`)).toBeUndefined();
});

test("an ended run leaves its results in the set's runs folder, once", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => mirador.started.length === 1, "the racer started");
  writeFileSync(join(mirador.started[0]!.folder, "answer.txt"), "42\n");
  await mirador.replied(1, finished("done"));

  const run = mirador.page();
  expect(run.phase).toBe("done");
  const runs = join(repo, "runs");
  const name = resultsName(run);
  expect(readdirSync(runs)).toEqual([name]);
  expect(readFileSync(join(runs, name), "utf8")).toBe(`${JSON.stringify(resultsFileOf(run), null, 2)}\n`);

  const stopped = miradorOf();
  await stopped.call(stopped.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => stopped.started.length === 1, "the racer started");
  expect(await stopped.act({ kind: "stop" })).toEqual({ stopped: true });

  const ended = stopped.page();
  expect(ended.phase).toBe("stopped");
  const stoppedName = resultsName(ended);
  expect(readdirSync(runs).sort()).toEqual([name, stoppedName].sort());
  expect(readFileSync(join(runs, stoppedName), "utf8")).toBe(`${JSON.stringify(resultsFileOf(ended), null, 2)}\n`);
  expect(await stopped.act({ kind: "stop" })).toEqual({ stopped: true });
  expect(readdirSync(runs), "a second Stop doesn't write again").toHaveLength(2);
});

test("a check that can't run fails its cell, saying why, and the run goes on", async () => {
  await makeSet(repo, ["a", "b"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], atOnce: 1 });
  await until(() => mirador.started.length === 1, "the first racer started");
  await rm(join(repo, "problems", "a", "check"), { recursive: true });
  writeFileSync(join(mirador.started[0]!.folder, "answer.txt"), "42\n");

  await mirador.replied(1, finished("done"));
  await until(() => mirador.started.length === 2, "the next problem's racer started");

  expect(mirador.page().cells[0]).toMatchObject({ state: "done", result: "failed", note: expect.stringContaining("Race couldn't run the check: ") });
  writeFileSync(join(mirador.started[1]!.folder, "answer.txt"), "42\n");
  await mirador.replied(2, finished("done"));
  expect(mirador.page().cells[1]!.result).toBe("passed");
  expect(mirador.page().phase).toBe("done");
});

test("a run of one problem on one column says so in the singular", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();

  const answer = await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });

  expect(answer).toBe(`Bench run ${mirador.page().id} started: 1 problem × 1 column on Tiny. The run page shows each result as it comes.`);
});

test("a run with deleteRacers deletes each racer once its result is kept, keeping its changes as the cell's patch", async () => {
  await makeSet(repo, ["a", "b"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], atOnce: 1, deleteRacers: true });
  await until(() => mirador.started.length === 1, "the first racer started");
  writeFileSync(join(mirador.started[0]!.folder, "answer.txt"), "42\n");
  writeFileSync(join(mirador.started[0]!.folder, "notes.md"), "how I solved it\n".repeat(4000));

  await mirador.replied(1, finished("done"));
  await until(() => mirador.started.length === 2, "the next racer started");

  const first = mirador.page().cells[0]!;
  expect(first).toMatchObject({ state: "done", result: "passed", conversationId: null, folder: null, branch: null });
  expect(first.patch).toContain("-0\n");
  expect(first.patch).toContain("+42\n");
  expect(first.patch!.endsWith(`[Cut at ${DIFF_LIMIT} characters.]`), "a long patch is cut, with nowhere left to look").toBe(true);
  expect(mirador.deleted).toEqual([mirador.started[0]!.id]);
  expect(await mirador.act({ kind: "diff", cell: 0 })).toEqual({ diff: first.patch });

  writeFileSync(join(mirador.started[1]!.folder, "answer.txt"), "42\n");
  await mirador.replied(2, finished("done"));

  const run = mirador.page();
  expect(run.phase).toBe("done");
  expect(mirador.deleted).toEqual(mirador.started.map(({ id }) => id));
  expect(run.cells[1]!.patch).toContain("+42\n");
  const results = JSON.parse(readFileSync(join(repo, "runs", resultsName(run)), "utf8")) as { cells: { patch: string | null }[] };
  expect(results.cells.map(({ patch }) => patch)).toEqual(run.cells.map(({ patch }) => patch));
});

test("with deleteRacers, a racer Mirador couldn't delete keeps its conversation, folder and branch on its cell", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf({ refuseDelete: () => true });
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], deleteRacers: true });
  await until(() => mirador.started.length === 1, "the racer started");
  const racer = mirador.started[0]!;
  writeFileSync(join(racer.folder, "answer.txt"), "42\n");

  await mirador.replied(1, finished("done"));

  expect(mirador.deleted).toEqual([]);
  expect(mirador.page().cells[0]).toMatchObject({ result: "passed", conversationId: racer.id, folder: racer.folder, branch: racer.branch, patch: null });
  expect(mirador.captain.storage.get(`benchRacer:${racer.id}`)).toEqual({ run: mirador.page().id, cell: 0 });
});

test("a run without deleteRacers deletes none, and its cells' patch stays null", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => mirador.started.length === 1, "the racer started");
  writeFileSync(join(mirador.started[0]!.folder, "answer.txt"), "42\n");

  await mirador.replied(1, finished("done"));

  const run = mirador.page();
  expect(run.phase).toBe("done");
  expect(run.deleteRacers).toBe(false);
  expect(mirador.deleted).toEqual([]);
  expect(run.cells[0]).toMatchObject({ result: "passed", patch: null, conversationId: mirador.started[0]!.id, folder: mirador.started[0]!.folder, branch: mirador.started[0]!.branch });
});

test("Stop run with deleteRacers deletes the racers it stopped, keeping their changes", async () => {
  await makeSet(repo, ["a", "b", "c"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], atOnce: 2, deleteRacers: true });
  await until(() => mirador.started.length === 2, "the racers started");
  writeFileSync(join(cellStart(mirador, 0).folder, "answer.txt"), "42\n");
  await rm(cellStart(mirador, 1).folder, { recursive: true, force: true });

  expect(await mirador.act({ kind: "stop" })).toEqual({ stopped: true });

  const run = mirador.page();
  expect(run.phase).toBe("stopped");
  expect(mirador.deleted.sort()).toEqual(mirador.started.map(({ id }) => id).sort());
  expect(run.cells[0]!.patch).toContain("+42\n");
  expect(run.cells[1]!.patch, "a folder already gone leaves no patch").toBeNull();
  expect(run.cells[2]!.patch, "a racer that never started has none").toBeNull();
  expect(run.cells.map(({ conversationId, folder, branch }) => [conversationId, folder, branch])).toEqual([
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ]);
  const results = JSON.parse(readFileSync(join(repo, "runs", resultsName(run)), "utf8"));
  expect(results.cells[0].patch, "the results file holds the patch").toContain("+42\n");
});

test("with deleteRacers, a racer that starts after Stop run is deleted", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();
  const start = holdStarts(mirador, () => true);
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }], deleteRacers: true });
  await until(() => start.held === 1, "the racer is starting");

  expect(await mirador.act({ kind: "stop" })).toEqual({ stopped: true });
  start.letThrough();
  await until(() => mirador.deleted.length === 1, "the racer that started late was deleted");

  const late = mirador.started[0]!;
  expect(mirador.deleted).toEqual([late.id]);
  expect(mirador.stopped, "deleted instead of only stopped").toEqual([]);
  expect(mirador.page().cells[0]).toMatchObject({ state: "done", result: "stopped", conversationId: null, folder: null, branch: null, startedAt: null });
});

test("the bench tool and the form's start keep deleteRacers", async () => {
  await makeSet(repo, ["answer"]);
  const asked = miradorOf({ caller: "agent" });
  await asked.call(asked.captain, "bench", { columns: [{ profile: "Kimi" }], deleteRacers: true });
  expect(asked.page()).toMatchObject({ phase: "setup", deleteRacers: true });
  expect(await asked.act({ kind: "start", columns: [{ profile: "Kimi" }], deleteRacers: true })).toEqual({ started: asked.page().id });
  expect(asked.page()).toMatchObject({ phase: "running", deleteRacers: true });
  await until(() => asked.started.length === 1, "the racer started");

  const unasked = miradorOf({ caller: "agent" });
  await unasked.call(unasked.captain, "bench", { columns: [{ profile: "Kimi" }] });
  expect(unasked.page()).toMatchObject({ phase: "setup", deleteRacers: false });
  expect(await unasked.act({ kind: "start", columns: [{ profile: "Kimi" }] })).toEqual({ started: unasked.page().id });
  expect(unasked.page().deleteRacers).toBe(false);
  await until(() => unasked.started.length === 1, "the racer started");

  const direct = miradorOf();
  await direct.call(direct.captain, "bench", { columns: [{ profile: "Kimi" }], deleteRacers: true });
  expect(direct.page().deleteRacers).toBe(true);
  await until(() => direct.started.length === 1, "the racer started");
});

test("the leaderboard action reads the set's results files, skipping strays, on a setup form too", async () => {
  await makeSet(repo, ["answer"]);
  const runs = join(repo, "runs");
  mkdirSync(runs, { recursive: true });
  const resultsFile = (id: string, startedAt: number, result: string) => ({
    run: id,
    set: "Tiny",
    commit: null,
    startedAt,
    endedAt: startedAt + 1,
    settings: {},
    columns: [{ profile: "Kimi", model: null, effort: null, ranOn: null }],
    cells: [{ problem: "answer", column: 0, attempt: 1, result, seconds: 40, tries: [], usage: null, note: null, patch: null }],
    totals: [],
  });
  writeFileSync(join(runs, "2026-11-13-aaaaaa.json"), JSON.stringify(resultsFile("aaaaaa", 1_000, "passed")));
  writeFileSync(join(runs, "2026-11-13-bbbbbb.json"), JSON.stringify(resultsFile("bbbbbb", 2_000, "failed")));
  writeFileSync(join(runs, "stray.json"), "not json");
  writeFileSync(join(runs, "nocells.json"), JSON.stringify({ run: "cccccc" }));
  writeFileSync(join(runs, "notes.txt"), "a stray note");
  const mirador = miradorOf({ caller: "agent" });
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  expect(mirador.page().phase).toBe("setup");

  const rows = (await mirador.act({ kind: "leaderboard" })) as LeaderboardRow[];

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ label: "Kimi", runs: 2, passed: 0, done: 1, passRate: 0, change: -1, sameProblems: true });
});

test("the leaderboard of an ended run counts the run once, before its results file is written and after", async () => {
  await makeSet(repo, ["answer"]);
  const mirador = miradorOf();
  await mirador.call(mirador.captain, "bench", { columns: [{ profile: "Kimi" }] });
  await until(() => mirador.started.length === 1, "the racer started");
  writeFileSync(join(mirador.started[0]!.folder, "answer.txt"), "42\n");
  await mirador.replied(1, finished("done"));
  expect(mirador.page().phase).toBe("done");
  const written = (await mirador.act({ kind: "leaderboard" })) as LeaderboardRow[];
  expect(written).toEqual([expect.objectContaining({ label: "Kimi", runs: 1, passed: 1 })]);

  await rm(join(repo, "runs"), { recursive: true });
  const notYetWritten = (await mirador.act({ kind: "leaderboard" })) as LeaderboardRow[];

  expect(notYetWritten).toEqual(written);
});
