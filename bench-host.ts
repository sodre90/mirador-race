import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasActionContext, CanvasPluginContext, CanvasPluginStorage, CanvasTool, ConversationReply, PluginActivityEvent, PluginItem, PluginItemType, PluginProfile, StartedConversation, ToolCaller } from "./mirador/api.ts";
import { cellsOf, cellsToStart, columnLabel, MAX_ATTEMPTS, MAX_AT_ONCE, newRunId, resultOf, resultsFileOf, retryPrompt, runSummary, type BenchCell, type BenchColumn, type BenchRun, type CellResult } from "./bench.ts";
import { checks, endLeftover, type StartedCheck } from "./check.ts";
import { copyCheckFiles, loadSet, validateProblem, type LoadedSet, type Problem, type ProblemValidation } from "./sets.ts";
import { diffOf } from "./git.ts";
import { DIFF_LIMIT, type CheckResult } from "./race.ts";

export const BENCH_ITEM_TYPE = "bench";

/** What the plugin keeps of a run across restarts: the run, and the conversation and item it shows in. */
interface KeptRun {
  run: BenchRun;
  captain: string;
  itemId: string;
}

interface KeptBenchRacer {
  run: string;
  cell: number;
}

interface BenchInput {
  columns?: { profile: string; model?: string; effort?: string }[];
  attempts?: number;
  tries?: 1 | 2;
  atOnce?: number;
  problems?: string[];
  deleteRacers?: boolean;
}

/** What a run's page asks of the plugin. */
type BenchPageAction =
  | { kind: "profiles" }
  | { kind: "set" }
  | { kind: "validate" }
  | ({ kind: "start" } & BenchInput)
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "diff"; cell: number };

/** The captain's latest context: a tool's when the run starts, the page's or replied's once they come; only those two can prompt a retry. */
type CaptainContext = CanvasPluginContext & Pick<CanvasActionContext, "prompt" | "startConversation" | "stopConversation" | "deleteStarted"> & Partial<Pick<CanvasActionContext, "promptStarted">>;

const runKey = (id: string) => `bench:${id}`;
const benchRacerKey = (conversationId: string) => `benchRacer:${conversationId}`;
/** A cell's running check, by its pid and start, which a restart of Mirador in place leaves running. */
const benchCheckKey = (id: string, cell: number) => `bench-check:${id}:${cell}`;
const cellKey = (id: string, cell: number) => `${id}:${cell}`;
const RUNS = "benchRuns";

const runCaptains = new Map<string, CaptainContext>();
const loadedSets = new Map<string, LoadedSet>();
/** The forms whose Start is starting their run, so a second press doesn't start it twice. */
const startingForms = new Set<string>();
/** The forms whose set is being validated, so a second press doesn't validate it twice. */
const validatingForms = new Set<string>();
/** The racers whose second try has begun, so the end of their first turn isn't taken for the second's. */
const retryTurnsBegun = new Set<string>();
/** The bench checks this run of Mirador runs, by `benchCheckKey`; a cell still checking but not here had its check cut short by a restart. */
const checksUnderWay = new Set<string>();
/** The cells this run of Mirador is starting a racer for, by `cellKey`; a cell still starting but not here had its start cut short by a restart. */
const startsUnderWay = new Set<string>();
/** The cells whose second try this run of Mirador began, by `cellKey`; a cell still retrying but not here had its second try cut short by a restart. */
const retriesUnderWay = new Set<string>();
/** The time limits of working and retrying cells, by `cellKey`. */
const timeLimits = new Map<string, ReturnType<typeof setTimeout>>();

const keptRun = (storage: CanvasPluginStorage, id: string) => storage.get(runKey(id)) as KeptRun | undefined;
export const benchRacerOf = (storage: CanvasPluginStorage, conversationId: string) => storage.get(benchRacerKey(conversationId)) as KeptBenchRacer | undefined;
const runIds = (storage: CanvasPluginStorage) => (storage.get(RUNS) as string[] | undefined) ?? [];

/** Changes the run in one go, with no await in between, so racers ending at once never undo each other's change; the run page follows. */
function updateRun(storage: CanvasPluginStorage, id: string, change: (run: BenchRun) => void): KeptRun | undefined {
  const kept = keptRun(storage, id);
  if (!kept) return undefined;
  change(kept.run);
  storage.set(runKey(id), kept);
  showOnPage(kept);
  return kept;
}

function showOnPage({ run, captain, itemId }: KeptRun) {
  try {
    runCaptains.get(captain)?.change(itemId, { data: run });
  } catch (error) {
    console.error(`bench run ${run.id}: its page could not show the change:`, error);
  }
}

async function setOf(run: BenchRun): Promise<LoadedSet> {
  const loaded = loadedSets.get(run.id);
  if (loaded) return loaded;
  const set = await loadSet(run.set.folder);
  loadedSets.set(run.id, set);
  return set;
}

function keepRun(storage: CanvasPluginStorage, run: BenchRun, captain: string, itemId: string) {
  storage.set(runKey(run.id), { run, captain, itemId } satisfies KeptRun);
  storage.set(RUNS, [...runIds(storage), run.id]);
}

const columnsOf = (asked: BenchInput["columns"], profiles: PluginProfile[]): BenchColumn[] =>
  (asked ?? []).map(({ profile, model, effort }) => {
    const known = profiles.find(({ name }) => name.toLowerCase() === profile.trim().toLowerCase());
    if (!known) throw new Error(`There is no profile named ${profile}.`);
    return { profile: known.name, model: model ?? null, effort: effort ?? null };
  });

function namedProblems(asked: string[] | undefined, set: LoadedSet): string[] {
  const named = asked ?? [];
  named.forEach((id) => {
    if (!set.problems.some((problem) => problem.id === id)) throw new Error(`The set has no problem ${id}.`);
  });
  return named;
}

const benchTitle = (run: BenchRun) => `Bench · ${run.set.name}`;

/** A run not started yet: its form, with what the user or the agent already said. */
function setupRun(asked: BenchInput, set: LoadedSet, columns: BenchColumn[], problems: string[]): BenchRun {
  return {
    id: newRunId(),
    set: { name: set.settings.name, folder: set.folder, commit: set.commit },
    settings: { ...set.settings, ...(asked.tries === undefined ? {} : { tries: asked.tries }) },
    columns,
    attempts: asked.attempts ?? 1,
    atOnce: asked.atOnce ?? 2,
    deleteRacers: asked.deleteRacers ?? false,
    problems,
    cells: [],
    phase: "setup",
    startedAt: null,
    endedAt: null,
  };
}

function newRun(asked: BenchInput, set: LoadedSet, profiles: PluginProfile[], id = newRunId()): BenchRun {
  const columns = columnsOf(asked.columns, profiles);
  if (columns.length === 0 || columns.length > 6) throw new Error("A run has 1 to 6 columns.");
  const named = namedProblems(asked.problems, set);
  const problems = named.length > 0 ? named : set.problems.map(({ id: problemId }) => problemId);
  const attempts = asked.attempts ?? 1;
  const atOnce = asked.atOnce ?? 2;
  const tries = asked.tries ?? set.settings.tries;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new Error(`A run has 1 to ${MAX_ATTEMPTS} attempts.`);
  if (!Number.isInteger(atOnce) || atOnce < 1 || atOnce > MAX_AT_ONCE) throw new Error(`A run runs 1 to ${MAX_AT_ONCE} racers of one profile at once.`);
  if (tries !== 1 && tries !== 2) throw new Error("Tries is 1 or 2.");
  return {
    id,
    set: { name: set.settings.name, folder: set.folder, commit: set.commit },
    settings: { ...set.settings, tries },
    columns,
    attempts,
    atOnce,
    deleteRacers: asked.deleteRacers ?? false,
    problems,
    cells: cellsOf(problems, columns.length, attempts),
    phase: "running",
    startedAt: Date.now(),
    endedAt: null,
  };
}

const countWords = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function startedWords(run: BenchRun, caller: ToolCaller): string {
  const attempts = run.attempts > 1 ? ` × ${run.attempts} attempts` : "";
  const last = caller === "agent" ? "You hear the results as your next message when it's over; carry on meanwhile, or end your turn." : "The run page shows each result as it comes.";
  return `Bench run ${run.id} started: ${countWords(run.problems.length, "problem")} × ${countWords(run.columns.length, "column")}${attempts} on ${run.set.name}. ${last}`;
}

async function commitOf(folder: string, start: string): Promise<string> {
  const child = Bun.spawn(["git", "-C", folder, "rev-parse", "--verify", "--quiet", `${start}^{commit}`], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`The set has no commit ${start}.`);
  return stdout.trim();
}

/** Ends a cell with its result, and the tokens and cost of its conversation where the captain can tell them. */
function markDone(cell: BenchCell, result: CellResult, note: string | null, captain: CaptainContext | undefined) {
  cell.state = "done";
  cell.result = result;
  cell.endedAt = Date.now();
  if (note !== null) cell.note = note;
  if (cell.conversationId && captain) {
    try {
      cell.usage = captain.usageOf(cell.conversationId);
    } catch {}
  }
}

/** Keeps a cell's changes as its patch, then deletes its racer's conversation and worktree, as the user's delete does. */
async function cleanUpRacer(storage: CanvasPluginStorage, id: string, index: number) {
  const kept = keptRun(storage, id);
  const cell = kept?.run.cells[index];
  if (!kept || !cell || !kept.run.deleteRacers || !cell.conversationId) return;
  const { conversationId } = cell;
  let patch: string | null = null;
  if (cell.folder && existsSync(cell.folder)) {
    try {
      const set = await setOf(kept.run);
      const problem = set.problems.find(({ id: problemId }) => problemId === cell.problem)!;
      const start = await commitOf(kept.run.set.folder, problem.start);
      const diff = await diffOf(cell.folder, start);
      patch = diff.length <= DIFF_LIMIT ? diff : `${diff.slice(0, DIFF_LIMIT)}\n\n[Cut at ${DIFF_LIMIT} characters.]`;
    } catch {}
  }
  storage.set(benchRacerKey(conversationId), undefined);
  try {
    await runCaptains.get(kept.captain)?.deleteStarted(conversationId);
  } catch (error) {
    console.error(`bench run ${id}: cell ${index}'s conversation could not be deleted:`, error);
  }
  updateRun(storage, id, (run) => {
    const cleaned = run.cells[index]!;
    cleaned.patch = patch;
    cleaned.conversationId = null;
    cleaned.folder = null;
    cleaned.branch = null;
  });
}

function clearTimeLimit(id: string, index: number) {
  const key = cellKey(id, index);
  const timer = timeLimits.get(key);
  if (timer !== undefined) clearTimeout(timer);
  timeLimits.delete(key);
}

/** Arms the set's time limit for a cell from when it started; one whose time is already past fires at once. */
function armTimeLimit(storage: CanvasPluginStorage, id: string, index: number) {
  const kept = keptRun(storage, id);
  const cell = kept?.run.cells[index];
  if (!kept || !cell || cell.startedAt === null) return;
  const left = cell.startedAt + kept.run.settings.agentTimeLimitMinutes * 60_000 - Date.now();
  clearTimeLimit(id, index);
  const key = cellKey(id, index);
  const timer = setTimeout(() => {
    timeLimits.delete(key);
    timeLimitReached(storage, id, index).catch((error) => console.error(`bench run ${id}: cell ${index} could not be timed out:`, error));
  }, Math.max(0, left));
  timer.unref();
  timeLimits.set(key, timer);
}

/** A racer past the set's time limit: its cell ends as timed out, its conversation stops, and the run goes on. */
async function timeLimitReached(storage: CanvasPluginStorage, id: string, index: number) {
  const kept = keptRun(storage, id);
  const cell = kept?.run.cells[index];
  if (!kept || !cell || kept.run.phase !== "running" || (cell.state !== "working" && cell.state !== "retrying")) return;
  const captain = runCaptains.get(kept.captain);
  const { conversationId } = cell;
  updateRun(storage, id, (run) => markDone(run.cells[index]!, "timed out", `It ran past the set's time limit of ${run.settings.agentTimeLimitMinutes} minutes.`, captain));
  if (kept.run.deleteRacers) await cleanUpRacer(storage, id, index);
  else if (captain && conversationId) await captain.stopConversation(conversationId).catch(() => {});
  await finishIfDone(storage, id);
  await advance(storage, id);
}

/** Whether a cell is still waiting for its racer to start: Stop run, or a resume, may have ended it while Mirador started it. */
function stillStarting(storage: CanvasPluginStorage, id: string, index: number) {
  const kept = keptRun(storage, id);
  return kept?.run.phase === "running" && kept.run.cells[index]?.state === "starting";
}

/** Starts the cells `cellsToStart` gives, each racer alone in a worktree from its problem's start. */
async function advance(storage: CanvasPluginStorage, id: string) {
  const kept = keptRun(storage, id);
  if (!kept) return;
  const captain = runCaptains.get(kept.captain);
  if (!captain) return;
  const picked = cellsToStart(kept.run);
  if (picked.length === 0) {
    await finishIfDone(storage, id);
    return;
  }
  updateRun(storage, id, (run) => picked.forEach((index) => (run.cells[index]!.state = "starting")));
  const startKeys = picked.map((index) => cellKey(id, index));
  startKeys.forEach((key) => startsUnderWay.add(key));
  try {
    const set = await setOf(kept.run);
    await Promise.all(picked.map(async (index) => {
      const current = keptRun(storage, id);
      if (!current || current.run.phase !== "running") return;
      const cell = current.run.cells[index]!;
      if (cell.state !== "starting") return;
      const column = current.run.columns[cell.column]!;
      const problem = set.problems.find(({ id: problemId }) => problemId === cell.problem)!;
      try {
        const started = await captain.startConversation({
          profile: column.profile,
          ...(column.model === null ? {} : { model: column.model }),
          ...(column.effort === null ? {} : { effort: column.effort }),
          prompt: problem.task,
          title: `Bench ${id} · ${cell.problem} · ${columnLabel(column)}`,
          worktree: { from: problem.start },
        });
        if (!started.worktree) throw new Error("This Mirador started a racer without a worktree of its own; bench needs Mirador's plugin API 14.");
        const startedInTime = stillStarting(storage, id, index);
        updateRun(storage, id, (run) => {
          const begun = run.cells[index]!;
          begun.conversationId = started.id;
          begun.folder = started.worktree!.folder;
          begun.branch = started.worktree!.branch;
          if (!startedInTime) return;
          begun.startedAt = Date.now();
          begun.state = "working";
        });
        if (!startedInTime) {
          if (current.run.deleteRacers) await cleanUpRacer(storage, id, index);
          else await captain.stopConversation(started.id).catch(() => {});
          return;
        }
        armTimeLimit(storage, id, index);
        storage.set(benchRacerKey(started.id), { run: id, cell: index } satisfies KeptBenchRacer);
      } catch (error) {
        if (stillStarting(storage, id, index)) await cellDone(storage, id, index, "couldn't start", error instanceof Error ? error.message : String(error));
      }
    }));
  } finally {
    startKeys.forEach((key) => startsUnderWay.delete(key));
  }
}

async function cellDone(storage: CanvasPluginStorage, id: string, index: number, result: CellResult, note: string | null = null) {
  clearTimeLimit(id, index);
  retriesUnderWay.delete(cellKey(id, index));
  const kept = keptRun(storage, id);
  const captain = kept ? runCaptains.get(kept.captain) : undefined;
  updateRun(storage, id, (run) => markDone(run.cells[index]!, result, note, captain));
  await cleanUpRacer(storage, id, index);
  await finishIfDone(storage, id);
  await advance(storage, id);
}

/**
 * Runs the problem's check in the racer's folder, ending first what's left of a run of it a restart of Mirador cut short.
 * Null when the check couldn't run at all, such as with the set's check files gone: the cell then ends as failed.
 */
async function runBenchCheck(storage: CanvasPluginStorage, id: string, index: number, { problem, folder, timeoutMs }: { problem: Problem; folder: string; timeoutMs: number }): Promise<CheckResult | null> {
  const key = benchCheckKey(id, index);
  checksUnderWay.add(key);
  try {
    const leftover = storage.get(key) as StartedCheck | undefined;
    if (leftover) await endLeftover(leftover);
    await copyCheckFiles(problem, folder);
    return await checks.check(id, problem.check, folder, (started) => storage.set(key, started), { timeoutMs });
  } catch (error) {
    await cellDone(storage, id, index, "failed", `Race couldn't run the check: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    checksUnderWay.delete(key);
    storage.set(key, undefined);
  }
}

/** Checks the cell's work with its problem's hidden files, and gives a failed racer its second try with what the check printed. */
async function checkCell(storage: CanvasPluginStorage, id: string, index: number) {
  const kept = keptRun(storage, id);
  if (!kept) return;
  const cell = kept.run.cells[index]!;
  retriesUnderWay.delete(cellKey(id, index));
  updateRun(storage, id, (run) => (run.cells[index]!.state = "checking"));
  const set = await setOf(kept.run);
  const problem = set.problems.find(({ id: problemId }) => problemId === cell.problem)!;
  const check = await runBenchCheck(storage, id, index, { problem, folder: cell.folder!, timeoutMs: kept.run.settings.checkTimeoutMinutes * 60_000 });
  if (check === null) return;
  updateRun(storage, id, (run) => run.cells[index]!.tries.push({ check, endedAt: Date.now() }));
  const run = keptRun(storage, id)!.run;
  const result = resultOf(run.cells[index]!.tries, run.settings.tries);
  if (result !== null) {
    await cellDone(storage, id, index, result);
    return;
  }
  retriesUnderWay.add(cellKey(id, index));
  updateRun(storage, id, (run) => (run.cells[index]!.state = "retrying"));
  try {
    await runCaptains.get(kept.captain)!.promptStarted!(cell.conversationId!, retryPrompt(check));
  } catch (error) {
    await cellDone(storage, id, index, "failed", error instanceof Error ? error.message : String(error));
  }
}

/** A racer's first turn ended: its work is checked, or its failure or stop ends the cell. */
export async function benchRacerEnded(started: StartedConversation, reply: ConversationReply, context: CaptainContext) {
  runCaptains.set(context.conversationId, context);
  const racer = benchRacerOf(context.storage, started.id);
  if (!racer) return;
  const kept = keptRun(context.storage, racer.run);
  if (!kept) return;
  updateRun(context.storage, racer.run, (run) => (run.cells[racer.cell]!.ranOn = reply.ranOn ?? null));
  const cell = keptRun(context.storage, racer.run)!.run.cells[racer.cell]!;
  if (kept.run.phase !== "running" || cell.state !== "working") return;
  if (reply.ended === "finished") await checkCell(context.storage, racer.run, racer.cell);
  else await cellDone(context.storage, racer.run, racer.cell, reply.ended === "failed" ? "agent failed" : "stopped");
}

/** A racer's second try began or ended; the end of its first turn, which Mirador also reports, is ignored. */
export async function benchActivity(event: PluginActivityEvent, storage: CanvasPluginStorage) {
  const racer = benchRacerOf(storage, event.conversationId);
  if (!racer) return;
  const cell = keptRun(storage, racer.run)?.run.cells[racer.cell];
  if (!cell || cell.state !== "retrying") return;
  if (event.kind === "turn-started") {
    retryTurnsBegun.add(event.conversationId);
    return;
  }
  if (event.kind !== "turn-ended" || !retryTurnsBegun.has(event.conversationId)) return;
  retryTurnsBegun.delete(event.conversationId);
  if (event.ended === "finished") await checkCell(storage, racer.run, racer.cell);
  else await cellDone(storage, racer.run, racer.cell, event.ended === "failed" ? "agent failed" : "stopped");
}

/** A run Mirador restarted during goes on once its page shows: cut-short checks run again, and cells left mid-retry or mid-start end with what happened. */
async function resumeRun(storage: CanvasPluginStorage, id: string) {
  const kept = keptRun(storage, id);
  if (!kept || kept.run.phase !== "running") return;
  const left = kept.run.cells.map((cell, index) => ({ cell, index }));
  const cutShort = left.filter(({ cell, index }) => cell.state === "checking" && !checksUnderWay.has(benchCheckKey(id, index)));
  const midRetry = left.filter(({ cell, index }) => cell.state === "retrying" && !retriesUnderWay.has(cellKey(id, index)));
  const midStart = left.filter(({ cell, index }) => cell.state === "starting" && !startsUnderWay.has(cellKey(id, index)));
  await Promise.all(cutShort.map(({ index }) => checkCell(storage, id, index)));
  for (const { index } of midRetry) await cellDone(storage, id, index, "failed", "Mirador restarted during its second try.");
  for (const { index } of midStart) await cellDone(storage, id, index, "couldn't start", "Mirador restarted as it started.");
  keptRun(storage, id)?.run.cells.forEach((cell, index) => {
    if (cell.state === "working" || cell.state === "retrying") armTimeLimit(storage, id, index);
  });
  await finishIfDone(storage, id);
  await advance(storage, id);
}

/** The run's results file in the set's runs/ folder, dated with the day the run started, in local time. */
const resultsFileName = (run: BenchRun) => {
  const started = new Date(run.startedAt!);
  const day = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, "0")}-${String(started.getDate()).padStart(2, "0")}`;
  return `${day}-${run.id}.json`;
};

/** Leaves the run's results with the set; a failure is logged and the run ends regardless. */
async function leaveResults(run: BenchRun, fileName: string) {
  const folder = join(run.set.folder, "runs");
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, fileName), `${JSON.stringify(resultsFileOf(run), null, 2)}\n`);
  } catch (error) {
    console.error(`bench run ${run.id}: its results could not be written to ${folder}:`, error);
  }
}

async function finishIfDone(storage: CanvasPluginStorage, id: string) {
  const kept = keptRun(storage, id);
  if (!kept || kept.run.phase !== "running" || kept.run.cells.some(({ result }) => result === null)) return;
  updateRun(storage, id, (run) => {
    run.phase = "done";
    run.endedAt = Date.now();
  });
  const run = keptRun(storage, id)!.run;
  const fileName = resultsFileName(run);
  await leaveResults(run, fileName);
  const captain = runCaptains.get(kept.captain);
  if (!captain) {
    console.error(`bench run ${id} is over, but Mirador was restarted since it started and can't tell the conversation that started it.`);
    return;
  }
  await captain.prompt(`${runSummary(run)} The results are also in runs/${fileName}. Tell the user in one line that bench run ${id} is over; its page has every result.`, { afterTurn: true });
}

async function stopRun(id: string, context: CaptainContext) {
  const kept = keptRun(context.storage, id);
  if (!kept) throw new Error("This run is no longer kept.");
  if (kept.run.phase !== "running") return { stopped: true };
  const ending = kept.run.cells.map((cell, index) => ({ cell, index })).filter(({ cell }) => cell.result === null);
  const working = ending.filter(({ cell }) => cell.state === "starting" || cell.state === "working" || cell.state === "retrying");
  updateRun(context.storage, id, (run) => {
    run.phase = "stopped";
    run.endedAt = Date.now();
    run.cells.forEach((cell) => {
      if (cell.result === null) markDone(cell, "stopped", null, context);
    });
  });
  kept.run.cells.forEach((_, index) => {
    clearTimeLimit(id, index);
    retriesUnderWay.delete(cellKey(id, index));
  });
  checks.stopRace(id);
  await Promise.all(working.flatMap(({ cell }) => (cell.conversationId ? [context.stopConversation(cell.conversationId).catch(() => {})] : [])));
  await Promise.all(ending.map(({ index }) => cleanUpRacer(context.storage, id, index)));
  const stopped = keptRun(context.storage, id);
  if (stopped) await leaveResults(stopped.run, resultsFileName(stopped.run));
  return { stopped: true };
}

async function startFromForm(form: PluginItem<BenchRun>, asked: BenchInput, context: CanvasActionContext) {
  if (form.data.phase !== "setup" || startingForms.has(form.data.id)) throw new Error("This run has started already.");
  startingForms.add(form.data.id);
  try {
    const set = await loadSet(form.data.set.folder);
    const run = newRun(asked, set, context.profiles(), form.data.id);
    runCaptains.set(context.conversationId, context);
    context.change(form.id, { title: benchTitle(run), data: run });
    keepRun(context.storage, run, context.conversationId, form.id);
    advance(context.storage, run.id).catch((error) => console.error(`bench run ${run.id} could not go on:`, error));
    return { started: run.id };
  } finally {
    startingForms.delete(form.data.id);
  }
}

/** Validates the set's problems one after another, putting each result on the form as it comes; a run that starts meanwhile ends it. */
async function validateSet(form: PluginItem<BenchRun>, context: CanvasActionContext) {
  const set = await loadSet(form.data.set.folder);
  const validation: ProblemValidation[] = [];
  for (const problem of set.problems) {
    validation.push(await validateProblem(set, problem));
    const current = context.items().find(({ id }) => id === form.id) as PluginItem<BenchRun> | undefined;
    if (!current || current.data.phase !== "setup") return;
    context.change(form.id, { data: { ...current.data, validation: [...validation] } });
  }
}

function validateFromForm(form: PluginItem<BenchRun>, context: CanvasActionContext) {
  if (form.data.phase !== "setup") throw new Error("The set can be validated only before the run starts.");
  if (validatingForms.has(form.data.id)) throw new Error("The set is being validated already.");
  validatingForms.add(form.data.id);
  validateSet(form, context)
    .catch((error) => console.error(`bench run ${form.data.id}: its set could not be validated:`, error))
    .finally(() => validatingForms.delete(form.data.id));
  return { validating: true };
}

/** A cell's work since its problem's start, as a patch, or why there is none to show yet. */
async function cellWork(storage: CanvasPluginStorage, id: string, index: number) {
  const kept = keptRun(storage, id);
  const cell = kept?.run.cells[index];
  if (!kept || !cell) throw new Error(`Run ${id} has no cell ${index}.`);
  if (!cell.folder && cell.patch !== null) return cell.patch;
  if (!cell.folder || !existsSync(cell.folder)) return "This racer hasn't started yet; look again in a minute.";
  const set = await setOf(kept.run);
  const problem = set.problems.find(({ id: problemId }) => problemId === cell.problem)!;
  const start = await commitOf(kept.run.set.folder, problem.start);
  const diff = await diffOf(cell.folder, start);
  if (!diff.trim()) return "This racer hasn't changed anything yet.";
  return diff.length <= DIFF_LIMIT ? diff : `${diff.slice(0, DIFF_LIMIT)}\n\n[Cut at ${DIFF_LIMIT} characters; the whole work is in ${cell.folder}.]`;
}

export async function benchAction(item: PluginItem<BenchRun>, action: unknown, context: CanvasActionContext) {
  runCaptains.set(context.conversationId, context);
  const asked = action as BenchPageAction;
  if (asked.kind === "profiles") return context.profiles();
  if (asked.kind === "set") {
    const set = await loadSet(item.data.set.folder);
    return { name: set.settings.name, problems: set.problems.map(({ id, tags }) => ({ id, tags })), problemsLeftOut: set.problemsLeftOut, settings: set.settings };
  }
  if (asked.kind === "validate") return validateFromForm(item, context);
  if (asked.kind === "start") return startFromForm(item, asked, context);
  if (asked.kind === "stop") return stopRun(item.data.id, context);
  if (asked.kind === "resume") {
    resumeRun(context.storage, item.data.id).catch((error) => console.error(`bench run ${item.data.id} could not go on after a restart:`, error));
    return { resuming: true };
  }
  if (asked.kind === "diff") return { diff: await cellWork(context.storage, item.data.id, asked.cell) };
  throw new Error("A run's page starts and stops its run and shows a racer's changes.");
}

export const benchItem: PluginItemType<BenchRun> = {
  icon: "⏱",
  placement: "page",
  outcome: (run) => {
    if (run.phase === "setup") return "new";
    if (run.phase === "running") return `${run.cells.filter(({ result }) => result !== null).length}/${run.cells.length} done`;
    return run.phase;
  },
};

const DRAFTED = "Bench run drafted on the canvas: the user checks it and presses Start run. You hear the results as your next message once it's over.";

export const benchTool: CanvasTool = {
  description:
    "Run a benchmark: every problem of the workspace's problem set, on each column (a profile, with a model and effort if given), each racer alone in a worktree from its problem's start. Race checks each racer's work with the problem's hidden check and gives a failed racer a second try with what the check printed, unless the set allows one try. Returns at once; you hear the results when the run is over.",
  command: { description: "Run a benchmark of this workspace's problem set; with no arguments, a form to fill in" },
  input: {
    type: "object",
    properties: {
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            profile: { type: "string", minLength: 1, description: "The Mirador profile this column's racers run on, by name." },
            model: { type: "string", minLength: 1, description: "A model of that profile's agent, by id or name, e.g. \"opus\"." },
            effort: { type: "string", minLength: 1, description: "An effort the model offers, e.g. \"high\"." },
          },
          required: ["profile"],
        },
        minItems: 1,
        maxItems: 6,
        description: "A profile for each column, with a model and effort if given; every problem runs on each of them.",
      },
      attempts: { type: "integer", minimum: 1, maximum: MAX_ATTEMPTS, description: "How many times each problem runs on each column; 1 unless the user asks for more." },
      tries: { type: "integer", enum: [1, 2], description: "How many tries a racer gets: 2 gives a failed racer one more turn with the check's output; the set's own when left out." },
      atOnce: { type: "integer", minimum: 1, maximum: MAX_AT_ONCE, description: "How many racers of one profile work at once; a local model serves only a few. 2 unless the user asks for another number." },
      problems: { type: "array", items: { type: "string", minLength: 1 }, description: "The problems to run, by id; all of the set's when left out." },
      deleteRacers: { type: "boolean", description: "Delete each racer's conversation and worktree once its result is kept, keeping its changes as a patch; false unless the user asks for it." },
    },
  },
  async run(input, context) {
    const asked = input as BenchInput;
    const set = await loadSet(context.workspace.folder);
    if (context.caller === "agent") {
      const columns = columnsOf(asked.columns, context.profiles());
      const problems = namedProblems(asked.problems, set);
      context.publish({ type: BENCH_ITEM_TYPE, title: "New bench run", data: setupRun(asked, set, columns, problems) });
      return DRAFTED;
    }
    if (!asked.columns || asked.columns.length === 0) {
      context.publish({ type: BENCH_ITEM_TYPE, title: "New bench run", data: setupRun(asked, set, [], asked.problems ?? []) });
      return "Choose the columns on the canvas, then press Start run.";
    }
    const run = newRun(asked, set, context.profiles());
    runCaptains.set(context.conversationId, context);
    const item = context.publish({ type: BENCH_ITEM_TYPE, title: benchTitle(run), data: run });
    keepRun(context.storage, run, context.conversationId, item.id);
    advance(context.storage, run.id).catch((error) => console.error(`bench run ${run.id} could not go on:`, error));
    return startedWords(run, context.caller);
  },
};