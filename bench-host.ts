import { existsSync } from "node:fs";
import type { CanvasActionContext, CanvasPluginContext, CanvasPluginStorage, CanvasTool, ConversationReply, PluginActivityEvent, PluginItem, PluginItemType, PluginProfile, StartedConversation, ToolCaller } from "./mirador/api.ts";
import { cellsOf, cellsToStart, columnLabel, MAX_ATTEMPTS, MAX_AT_ONCE, newRunId, resultOf, retryPrompt, runSummary, type BenchColumn, type BenchRun, type CellResult } from "./bench.ts";
import { checks } from "./check.ts";
import { copyCheckFiles, loadSet, type LoadedSet } from "./sets.ts";
import { diffOf } from "./git.ts";
import { DIFF_LIMIT } from "./race.ts";

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
}

/** What a run's page asks of the plugin. */
type BenchPageAction =
  | { kind: "profiles" }
  | { kind: "set" }
  | ({ kind: "start" } & BenchInput)
  | { kind: "stop" }
  | { kind: "diff"; cell: number };

/** The captain's latest context: a tool's when the run starts, the page's or replied's once they come; only those two can prompt a retry. */
type CaptainContext = CanvasPluginContext & Pick<CanvasActionContext, "prompt" | "startConversation" | "stopConversation"> & Partial<Pick<CanvasActionContext, "promptStarted">>;

const runKey = (id: string) => `bench:${id}`;
const benchRacerKey = (conversationId: string) => `benchRacer:${conversationId}`;
const RUNS = "benchRuns";

const runCaptains = new Map<string, CaptainContext>();
const loadedSets = new Map<string, LoadedSet>();
/** The forms whose Start is starting their run, so a second press doesn't start it twice. */
const startingForms = new Set<string>();
/** The racers whose second try has begun, so the end of their first turn isn't taken for the second's. */
const retryTurnsBegun = new Set<string>();

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
    problems,
    cells: cellsOf(problems, columns.length, attempts),
    phase: "running",
    startedAt: Date.now(),
    endedAt: null,
  };
}

function startedWords(run: BenchRun, caller: ToolCaller): string {
  const attempts = run.attempts > 1 ? ` × ${run.attempts} attempts` : "";
  const last = caller === "agent" ? "You hear the results as your next message when it's over; carry on meanwhile, or end your turn." : "The run page shows each result as it comes.";
  return `Bench run ${run.id} started: ${run.problems.length} problems × ${run.columns.length} columns${attempts} on ${run.set.name}. ${last}`;
}

async function commitOf(folder: string, start: string): Promise<string> {
  const child = Bun.spawn(["git", "-C", folder, "rev-parse", "--verify", "--quiet", `${start}^{commit}`], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`The set has no commit ${start}.`);
  return stdout.trim();
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
  const set = await setOf(kept.run);
  await Promise.all(
    picked.map(async (index) => {
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
        updateRun(storage, id, (run) => {
          const begun = run.cells[index]!;
          begun.conversationId = started.id;
          begun.folder = started.worktree!.folder;
          begun.branch = started.worktree!.branch;
          begun.startedAt = Date.now();
          begun.state = "working";
        });
        storage.set(benchRacerKey(started.id), { run: id, cell: index } satisfies KeptBenchRacer);
      } catch (error) {
        await cellDone(storage, id, index, "couldn't start", error instanceof Error ? error.message : String(error));
      }
    }),
  );
}

async function cellDone(storage: CanvasPluginStorage, id: string, index: number, result: CellResult, note: string | null = null) {
  updateRun(storage, id, (run) => {
    const cell = run.cells[index]!;
    cell.state = "done";
    cell.result = result;
    cell.endedAt = Date.now();
    if (note !== null) cell.note = note;
  });
  await finishIfDone(storage, id);
  await advance(storage, id);
}

/** Checks the cell's work with its problem's hidden files, and gives a failed racer its second try with what the check printed. */
async function checkCell(storage: CanvasPluginStorage, id: string, index: number) {
  const kept = keptRun(storage, id);
  if (!kept) return;
  const cell = kept.run.cells[index]!;
  updateRun(storage, id, (run) => (run.cells[index]!.state = "checking"));
  const set = await setOf(kept.run);
  const problem = set.problems.find(({ id: problemId }) => problemId === cell.problem)!;
  await copyCheckFiles(problem, cell.folder!);
  const check = await checks.check(id, problem.check, cell.folder!, undefined, { timeoutMs: kept.run.settings.checkTimeoutMinutes * 60_000 });
  updateRun(storage, id, (run) => run.cells[index]!.tries.push({ check, endedAt: Date.now() }));
  const run = keptRun(storage, id)!.run;
  const result = resultOf(run.cells[index]!.tries, run.settings.tries);
  if (result !== null) {
    await cellDone(storage, id, index, result);
    return;
  }
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

async function finishIfDone(storage: CanvasPluginStorage, id: string) {
  const kept = keptRun(storage, id);
  if (!kept || kept.run.phase !== "running" || kept.run.cells.some(({ result }) => result === null)) return;
  updateRun(storage, id, (run) => {
    run.phase = "done";
    run.endedAt = Date.now();
  });
  const captain = runCaptains.get(kept.captain);
  if (!captain) {
    console.error(`bench run ${id} is over, but Mirador was restarted since it started and can't tell the conversation that started it.`);
    return;
  }
  const run = keptRun(storage, id)!.run;
  await captain.prompt(`${runSummary(run)} Tell the user in one line that bench run ${id} is over; its page has every result.`, { afterTurn: true });
}

async function stopRun(id: string, context: CaptainContext) {
  const kept = keptRun(context.storage, id);
  if (!kept) throw new Error("This run is no longer kept.");
  const working = kept.run.cells.filter(({ state, result }) => result === null && (state === "starting" || state === "working" || state === "retrying"));
  updateRun(context.storage, id, (run) => {
    run.phase = "stopped";
    run.endedAt = Date.now();
    run.cells.forEach((cell) => {
      if (cell.result !== null) return;
      cell.state = "done";
      cell.result = "stopped";
      cell.endedAt = Date.now();
    });
  });
  checks.stopRace(id);
  await Promise.all(working.flatMap(({ conversationId }) => (conversationId ? [context.stopConversation(conversationId).catch(() => {})] : [])));
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

/** A cell's work since its problem's start, as a patch, or why there is none to show yet. */
async function cellWork(storage: CanvasPluginStorage, id: string, index: number) {
  const kept = keptRun(storage, id);
  const cell = kept?.run.cells[index];
  if (!kept || !cell) throw new Error(`Run ${id} has no cell ${index}.`);
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
  if (asked.kind === "start") return startFromForm(item, asked, context);
  if (asked.kind === "stop") return stopRun(item.data.id, context);
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