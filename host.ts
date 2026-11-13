import { existsSync } from "node:fs";
import type { CanvasActionContext, CanvasHost, CanvasPluginContext, CanvasPluginStorage, CanvasToolContext, ConversationReply, PluginActivityEvent, StartedConversation } from "./mirador/api.ts";
import { CheckQueue, endLeftover, type StartedCheck } from "./check.ts";
import { changesOf, diffOf, raceBase } from "./git.ts";
import {
  DIFF_LIMIT,
  MAX_RACERS,
  MIN_RACERS,
  NOTE_LIMIT,
  SAID_LIMIT,
  blankRace,
  boardAnswer,
  conversationWorks,
  cut,
  isWorking,
  newRaceId,
  pickMessage,
  pickWords,
  pickingPrompt,
  profileOf,
  raceRequest,
  raceTitle,
  racerPrompt,
  refusalOfVote,
  tally,
  votePrompt,
  type Decide,
  type Race,
  type RacePick,
  type RaceRequest,
  type Racer,
} from "./race.ts";

export const ITEM_TYPE = "race";

/** The racer number a note of the conversation that started the race carries. */
export const CAPTAIN = 0;

/** A changed file shows on the race page within this long of a racer's tool call. */
const CHANGES_REFRESH_MS = 5_000;

/** Two checks at once: more would slow each other down, as several test suites on one machine do. */
const CHECKS_AT_ONCE = 2;

/** What the plugin keeps of a race across restarts: the race, and the conversation and item it shows in. */
interface KeptRace {
  race: Race;
  captain: string;
  itemId: string;
}

interface KeptRacer {
  race: string;
  number: number;
}

interface RaceInput {
  task?: string;
  profile?: string;
  profiles?: string[];
  racers?: number;
  check?: string;
  decide?: Decide;
}

/** What a race's page asks of the plugin. */
type PageAction =
  | { kind: "profiles" }
  | ({ kind: "start" } & RaceInput)
  | { kind: "stop" }
  | { kind: "diff"; racer: number }
  | { kind: "resume" }
  | { kind: "pick"; pick: RacePick }
  | { kind: "picked"; pick: RacePick };

/** What starting a race takes of the conversation it starts from, a tool's call or the user's press on the form. */
type StartsRacers = CanvasPluginContext<Race> & Pick<CanvasActionContext<Race>, "startConversation" | "stopConversation" | "prompt">;

const raceKey = (id: string) => `race:${id}`;
const racerKey = (conversationId: string) => `racer:${conversationId}`;
const readKey = (conversationId: string) => `read:${conversationId}`;
/** A racer's running check, by its pid and start, which a restart of Mirador in place leaves running. */
const startedCheckKey = (id: string, number: number) => `check:${id}:${number}`;
const RACES = "races";

/** The conversations' contexts this run of Mirador has seen: the captain's to change its race page and tell it, a racer's to ask for its vote. */
const captains = new Map<string, CanvasPluginContext<Race> & { prompt: CanvasActionContext["prompt"] }>();
const racerContexts = new Map<string, CanvasToolContext<Race>>();
const refreshes = new Map<string, { running: boolean; last: number }>();
/** The forms whose Start is starting their race, so a second press doesn't start it twice. */
const startingForms = new Set<string>();
const checks = new CheckQueue(CHECKS_AT_ONCE);
/** The racers this run of Mirador checks, by `startedCheckKey`; a racer still checking but not here had its check cut short by a restart. */
const checksUnderWay = new Set<string>();

const keptRace = (storage: CanvasPluginStorage, id: string) => storage.get(raceKey(id)) as KeptRace | undefined;
const keptRacer = (storage: CanvasPluginStorage, conversationId: string) => storage.get(racerKey(conversationId)) as KeptRacer | undefined;
const raceIds = (storage: CanvasPluginStorage) => (storage.get(RACES) as string[] | undefined) ?? [];

/** Changes the race in one go, with no await in between, so racers calling at once never undo each other's change; the race page follows. */
function update(storage: CanvasPluginStorage, id: string, change: (race: Race) => void): KeptRace | undefined {
  const kept = keptRace(storage, id);
  if (!kept) return undefined;
  change(kept.race);
  storage.set(raceKey(id), kept);
  showOnPage(kept);
  return kept;
}

function showOnPage({ race, captain, itemId }: KeptRace) {
  try {
    captains.get(captain)?.change(itemId, { data: race });
  } catch (error) {
    console.error(`race ${race.id}: its page could not show the change:`, error);
  }
}

/** The race this conversation takes part in, and as which racer; the captain is CAPTAIN, of its newest race. */
function membership(storage: CanvasPluginStorage, conversationId: string): { kept: KeptRace; number: number } | null {
  const racer = keptRacer(storage, conversationId);
  if (racer) {
    const kept = keptRace(storage, racer.race);
    return kept ? { kept, number: racer.number } : null;
  }
  const led = raceIds(storage)
    .map((id) => keptRace(storage, id))
    .findLast((kept) => kept?.captain === conversationId);
  return led ? { kept: led, number: CAPTAIN } : null;
}

const notAMember = () => new Error("Only a race's racers and the conversation that started it use the race tools; a race starts from its form on the canvas.");

/** What every racer changed since the race's base, at most every few seconds per race unless `now`. */
async function refreshChanges(storage: CanvasPluginStorage, id: string, { now = false } = {}) {
  const refresh = refreshes.get(id) ?? { running: false, last: 0 };
  refreshes.set(id, refresh);
  if (refresh.running || (!now && Date.now() - refresh.last < CHANGES_REFRESH_MS)) return;
  refresh.running = true;
  try {
    const kept = keptRace(storage, id);
    if (!kept) return;
    const { racers } = kept.race;
    const made = racers.filter(({ folder }) => existsSync(folder));
    const base = kept.race.base ?? (made.length === racers.length ? await raceBase(made[0]!.folder, racers.map(({ branch }) => branch)) : null);
    if (!base) return;
    const changes = await Promise.all(made.map(async ({ number, folder }) => ({ number, changes: await changesOf(folder, base).catch(() => null) })));
    update(storage, id, (race) => {
      race.base = base;
      for (const { number, changes: changed } of changes) {
        const racer = race.racers.find((each) => each.number === number);
        if (racer && changed) racer.changes = changed;
      }
    });
  } finally {
    refresh.running = false;
    refresh.last = Date.now();
  }
}

/** A racer's work since the race's base, as a patch, or why there is none to show yet. */
async function racerWork(storage: CanvasPluginStorage, id: string, number: number) {
  const race = keptRace(storage, id)?.race;
  const racer = race?.racers.find((each) => each.number === number);
  if (!race || !racer) throw new Error(`Race ${id} has racers 1 to ${race?.racers.length ?? 0}.`);
  await refreshChanges(storage, id, { now: true });
  const base = keptRace(storage, id)!.race.base;
  if (!base || !existsSync(racer.folder)) return `Racer ${number} hasn't started yet; look again in a minute.`;
  const diff = await diffOf(racer.folder, base);
  if (!diff.trim()) return `Racer ${number} hasn't changed anything yet.`;
  return diff.length <= DIFF_LIMIT ? diff : `${diff.slice(0, DIFF_LIMIT)}\n\n[Cut at ${DIFF_LIMIT} characters; the whole work is in ${racer.folder}.]`;
}

function newRace(request: RaceRequest, id = newRaceId()): Race {
  return { ...blankRace(request), ...request, id, phase: "racing", startedAt: Date.now() };
}

function startedRacer(number: number, started: StartedConversation): Racer {
  if (!started.worktree) throw new Error("This Mirador started a racer without a worktree of its own; race needs Mirador's plugin API 13.");
  return {
    number,
    conversationId: started.id,
    profile: started.profile,
    folder: started.worktree.folder,
    branch: started.worktree.branch,
    state: "starting",
    changes: null,
    said: null,
    startedAt: Date.now(),
    endedAt: null,
    check: null,
  };
}

/**
 * The first racer starts before the race shows, as it is the one a workspace outside git refuses; then `show` puts the
 * race on its page, which every racer after it joins as it starts. One that can't start stops the race.
 */
async function startRace(race: Race, context: StartsRacers, show: (race: Race) => string) {
  const start = async (number: number) => {
    const started = await context.startConversation({ profile: profileOf(race.profiles, number), prompt: racerPrompt(race, number, race.size), title: `Race ${race.id} · racer ${number}`, worktree: "own" });
    context.storage.set(racerKey(started.id), { race: race.id, number } satisfies KeptRacer);
    return startedRacer(number, started);
  };
  race.racers.push(await start(1));
  const itemId = show(race);
  captains.set(context.conversationId, context);
  context.storage.set(raceKey(race.id), { race, captain: context.conversationId, itemId } satisfies KeptRace);
  context.storage.set(RACES, [...raceIds(context.storage), race.id]);
  for (let number = 2; number <= race.size; number++) {
    try {
      const racer = await start(number);
      update(context.storage, race.id, (changed) => changed.racers.push(racer));
    } catch (error) {
      update(context.storage, race.id, (changed) => (changed.phase = "stopped"));
      await Promise.all(keptRace(context.storage, race.id)!.race.racers.map(({ conversationId }) => context.stopConversation(conversationId).catch(() => {})));
      throw error;
    }
  }
  return keptRace(context.storage, race.id)!.race;
}

async function startFromForm(form: { id: string; data: Race }, asked: RaceInput, context: CanvasActionContext<Race>) {
  if (form.data.phase !== "setup" || startingForms.has(form.data.id)) throw new Error("This race has started already.");
  const request = raceRequest(asked);
  if (typeof request === "string") throw new Error(request);
  startingForms.add(form.data.id);
  try {
    const race = await startRace(newRace(request, form.data.id), context, (race) => {
      context.change(form.id, { title: raceTitle(race.task), data: race });
      return form.id;
    });
    return { started: race.id };
  } finally {
    startingForms.delete(form.data.id);
  }
}

/** Once every racer's work has ended and been checked: the vote if the race asked for one and some racers can cast it, else the pick. */
async function afterTheRace(storage: CanvasPluginStorage, id: string) {
  await refreshChanges(storage, id, { now: true });
  const kept = keptRace(storage, id);
  if (!kept || kept.race.racers.length < kept.race.size || kept.race.racers.some(isWorking) || kept.race.phase !== "racing") return;
  const finished = kept.race.racers.filter(({ state }) => state === "finished");
  const voters = kept.race.decide === "vote" && finished.length > 1 ? finished.filter(({ conversationId }) => racerContexts.has(conversationId)) : [];
  if (voters.length === 0) return raceOver(storage, id);
  update(storage, id, (race) => {
    race.phase = "voting";
    race.voters = voters.map(({ number }) => number);
  });
  for (const { conversationId, number } of voters) {
    await racerContexts.get(conversationId)!.prompt(votePrompt(keptRace(storage, id)!.race, number), { afterTurn: true });
  }
}

/** The captain hears how the race ended, and to wait for the user's pick. */
async function raceOver(storage: CanvasPluginStorage, id: string) {
  const kept = update(storage, id, (race) => {
    if (race.votes.length > 0) race.standings = tally(race);
    race.phase = "picking";
  });
  if (!kept) return;
  const captain = captains.get(kept.captain);
  if (!captain) {
    console.error(`race ${id} is over, but Mirador was restarted since it started and can't tell the conversation that started it.`);
    return;
  }
  await captain.prompt(pickingPrompt(kept.race), { afterTurn: true });
}

/** Every voter voted, or ended its turn without: the race is over, with the standings. */
async function countIfAllVoted(storage: CanvasPluginStorage, id: string) {
  const race = keptRace(storage, id)?.race;
  if (!race || race.phase !== "voting") return;
  const heard = new Set([...race.votes.map(({ racer }) => racer), ...race.abstained]);
  if (race.voters.every((voter) => heard.has(voter))) await raceOver(storage, id);
}

/** Marks how the racer's work ended; one that finished a race with a check is checked next. */
function racerEnded(storage: CanvasPluginStorage, conversationId: string, reply: ConversationReply) {
  const racer = keptRacer(storage, conversationId);
  if (!racer) return null;
  let toCheck: { command: string; folder: string } | null = null;
  update(storage, racer.race, (race) => {
    const ended = race.racers.find(({ number }) => number === racer.number);
    if (!ended) return;
    const checks = reply.ended === "finished" && race.check !== null && race.phase === "racing";
    ended.state = checks ? "checking" : reply.ended;
    ended.said = reply.text === null ? null : cut(reply.text.trim(), SAID_LIMIT);
    ended.endedAt = Date.now();
    if (checks) toCheck = { command: race.check!, folder: ended.folder };
  });
  return { race: racer.race, number: racer.number, toCheck: toCheck as { command: string; folder: string } | null };
}

/** Runs the race's check in the racer's folder, ending first what's left of a run of it a restart of Mirador cut short. */
async function checkRacer(storage: CanvasPluginStorage, id: string, number: number, { command, folder }: { command: string; folder: string }) {
  const key = startedCheckKey(id, number);
  checksUnderWay.add(key);
  try {
    const leftover = storage.get(key) as StartedCheck | undefined;
    if (leftover) await endLeftover(leftover);
    const result = await checks.check(id, command, folder, (started) => storage.set(key, started));
    update(storage, id, (race) => {
      const checked = race.racers.find((racer) => racer.number === number);
      if (!checked) return;
      checked.check = result;
      checked.state = "finished";
    });
  } finally {
    checksUnderWay.delete(key);
    storage.set(key, undefined);
  }
}

/**
 * A race a restart of Mirador cut short goes on: the checks it cut short run again, as nothing else would end those
 * racers, and a race whose racers had all ended moves on to the vote or the pick.
 */
async function resumeRace(storage: CanvasPluginStorage, id: string) {
  const race = keptRace(storage, id)?.race;
  if (race?.phase !== "racing") return;
  const cutShort = race.racers.filter(({ number, state }) => state === "checking" && !checksUnderWay.has(startedCheckKey(id, number)));
  await Promise.all(cutShort.map(({ number, folder }) => checkRacer(storage, id, number, { command: race.check!, folder })));
  await afterTheRace(storage, id);
}

/** The voters whose vote turn has begun, by race, so the end of the turn they finished the race in isn't taken for their vote's. */
const voteTurnsBegun = new Map<string, Set<number>>();

async function hearActivity(event: PluginActivityEvent, storage: CanvasPluginStorage) {
  const racer = keptRacer(storage, event.conversationId);
  if (!racer) return;
  const race = keptRace(storage, racer.race)?.race;
  if (!race) return;
  if (event.kind === "turn-started" && race.phase === "racing") {
    update(storage, race.id, (changed) => {
      const started = changed.racers.find(({ number, state }) => number === racer.number && state === "starting");
      if (started) started.state = "working";
    });
  }
  if (event.kind === "tool-ended" && race.phase === "racing") await refreshChanges(storage, race.id);
  if (race.phase !== "voting" || !race.voters.includes(racer.number)) return;
  const begun = voteTurnsBegun.get(race.id) ?? new Set<number>();
  voteTurnsBegun.set(race.id, begun);
  if (event.kind === "turn-started") begun.add(racer.number);
  if (event.kind === "turn-ended" && begun.has(racer.number) && !race.votes.some((vote) => vote.racer === racer.number)) {
    update(storage, race.id, (changed) => changed.abstained.push(racer.number));
    await countIfAllVoted(storage, race.id);
  }
}

async function stopRace(id: string, context: CanvasActionContext<Race>) {
  const kept = update(context.storage, id, (race) => {
    if (race.phase === "racing") race.phase = "stopped";
  });
  if (!kept) throw new Error("This race is no longer kept.");
  checks.stopRace(id);
  await Promise.all(kept.race.racers.filter(conversationWorks).map(({ conversationId }) => context.stopConversation(conversationId)));
  return { stopped: true };
}

function racePicking(id: string, storage: CanvasPluginStorage) {
  const race = keptRace(storage, id)?.race;
  if (!race) throw new Error("This race is no longer kept.");
  if (race.phase !== "picking") throw new Error(`Race ${race.id} isn't waiting for a pick.`);
  return race;
}

/** The message that hands the user's pick to the captain, which the page sends as their own. */
const pick = (id: string, chosen: RacePick, storage: CanvasPluginStorage) => ({ message: pickMessage(racePicking(id, storage), chosen) });

/** Once the page sent the pick, the race is the captain's to finish. */
function picked(id: string, chosen: RacePick, storage: CanvasPluginStorage) {
  racePicking(id, storage);
  update(storage, id, (race) => {
    race.phase = "deciding";
    race.picked = pickWords(chosen);
  });
  return { picked: true };
}

const raceDescription =
  "Draft a race for the user to start: several conversations at once, e.g. four of a small model, or one on each of several profiles to compare them, each in a git worktree and branch of its own, working on the same task and sharing a board where they post what they learn. This puts the race's form on the canvas, filled in with what you pass; nothing runs until the user checks it and presses Start race, so leave out profiles you aren't sure they want. When all racers have finished you hear their results as your next message; the user picks the work to take on the race page, or hands the pick to you. With decide: vote, the racers rank each other's work first. Racers branch from the last commit, so commit what they need first; the workspace's worktree setup command, such as installing dependencies, runs in each racer's folder before it starts.";

const DRAFTED =
  "The race's form is on the canvas, filled in with what you asked. Nothing runs until the user checks it and presses Start race: tell them it waits for them. When all racers have finished you hear their results, and the user picks the work to take on the race page.";

/** The race's form on the canvas, filled in with what was asked, for the user to finish and start. */
function publishForm(asked: RaceInput, context: CanvasToolContext<Race>) {
  const profiles = asked.profiles ?? (asked.profile ? [asked.profile] : undefined);
  context.publish({
    type: ITEM_TYPE,
    title: "New race",
    data: blankRace({ task: asked.task?.trim(), profiles, size: asked.racers, check: asked.check?.trim() || null, decide: asked.decide }),
  });
}

/** What's wrong with the agent's draft that the form can't show: a missing task, or a profile Mirador doesn't have. */
function draftProblem(asked: RaceInput, context: CanvasToolContext<Race>) {
  if (!asked.task?.trim()) return "Say what the racers should do: the task.";
  const known = context.profiles().map(({ name }) => name.toLowerCase());
  const unknown = [...(asked.profiles ?? []), ...(asked.profile ? [asked.profile] : [])].filter((name) => !known.includes(name.trim().toLowerCase()));
  if (unknown.length === 0) return null;
  return `There is no profile named ${unknown.join(", ")}. The profiles are: ${context.profiles().map(({ name }) => name).join(", ")}; or leave profiles out for the user to choose.`;
}

const host: CanvasHost<Race> = {
  items: {
    [ITEM_TYPE]: {
      icon: "⚑",
      placement: "page",
      outcome: (race) => {
        if (race.phase === "setup") return "new";
        if (race.phase === "racing") return `${race.racers.filter((racer) => !isWorking(racer)).length}/${race.racers.length} done`;
        if (race.phase === "voting") return `voting ${race.votes.length}/${race.voters.length}`;
        if (race.phase === "picking") return "your pick";
        return race.phase;
      },
    },
  },
  tools: {
    race: {
      description: raceDescription,
      command: { description: "Race a task on several agents; with no arguments, a form to fill in" },
      input: {
        type: "object",
        properties: {
          task: { type: "string", minLength: 1, description: "Everything the racers need: what to do, which files or commands, and how to tell it works. They see nothing of this conversation." },
          profile: { type: "string", minLength: 1, description: "The Mirador profile every racer runs on, by name; the user can change it on the form." },
          profiles: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: MAX_RACERS,
            description: "Instead of profile: a profile for each racer, by name, in racer order, such as several models to compare; with fewer than the racers, they repeat in turn.",
          },
          racers: { type: "integer", minimum: MIN_RACERS, maximum: MAX_RACERS, description: "How many racers; one per profile when several are named, else 4, unless the user names another number." },
          check: {
            type: "string",
            minLength: 1,
            description: "A command that tells whether the work is right, e.g. the project's tests; each racer runs it before it finishes, and Race runs it in each racer's folder once that racer is done.",
          },
          decide: { type: "string", enum: ["captain", "vote"], description: "captain (the default): the pick comes as soon as they finish. vote: the racers first rank each other's work." },
        },
      },
      async run(input, context) {
        const asked = input as RaceInput;
        if (context.caller === "agent") {
          const problem = draftProblem(asked, context);
          if (problem) throw new Error(problem);
          publishForm(asked, context);
          return DRAFTED;
        }
        const request = raceRequest(asked);
        if (typeof request === "string") {
          publishForm(asked, context);
          return "Fill in the race on the canvas, then press Start race.";
        }
        const race = await startRace(newRace(request), context, (race) => context.publish({ type: ITEM_TYPE, title: raceTitle(race.task), data: race }).id);
        const racers = race.racers.map(({ number, profile, branch }) => `racer ${number} on ${profile}, branch ${branch}`).join("; ");
        return `Race ${race.id} started: ${race.racers.length} racers, each in a worktree of its own (${racers}). They share a board you can read with race_board, and post to, to steer them. When all have finished, you pick the work to take on the race page.`;
      },
    },
    race_board: {
      description:
        "For a race's racers, and the conversation that started it: read the notes the other racers posted since you last read, and where each racer is, and post a note of your own: your plan, what you learned, what failed.",
      input: {
        type: "object",
        properties: { post: { type: "string", minLength: 1, description: "A note for the others: a plan, a finding, a dead end, a test that catches it." } },
      },
      async run(input, context) {
        const member = membership(context.storage, context.conversationId);
        if (!member) throw notAMember();
        const { number } = member;
        const id = member.kept.race.id;
        if (number === CAPTAIN) captains.set(context.conversationId, context);
        else racerContexts.set(context.conversationId, context);
        const { post } = input as { post?: string };
        if (post?.trim()) update(context.storage, id, (race) => race.board.push({ racer: number, at: Date.now(), text: cut(post.trim(), NOTE_LIMIT) }));
        await refreshChanges(context.storage, id, { now: true });
        const race = keptRace(context.storage, id)!.race;
        const read = (context.storage.get(readKey(context.conversationId)) as number | undefined) ?? 0;
        const unread = race.board.slice(read).filter((note) => note.racer !== number);
        context.storage.set(readKey(context.conversationId), race.board.length);
        return boardAnswer(race, number === CAPTAIN ? null : number, unread, Date.now());
      },
    },
    race_peek: {
      description: "For a race's racers, and the conversation that started it: a racer's work so far, as a diff from where the race started, committed or not, new files included.",
      input: {
        type: "object",
        properties: { racer: { type: "integer", minimum: 1, description: "The racer's number." } },
        required: ["racer"],
      },
      async run(input, context) {
        const member = membership(context.storage, context.conversationId);
        if (!member) throw notAMember();
        if (member.number !== CAPTAIN) racerContexts.set(context.conversationId, context);
        return racerWork(context.storage, member.kept.race.id, (input as { racer: number }).racer);
      },
    },
    race_vote: {
      description: "For a race's racers, when asked to vote: rank the other racers' work, best first, and say why.",
      input: {
        type: "object",
        properties: {
          ranking: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, description: "The other racers' numbers, best first." },
          why: { type: "string", minLength: 1, description: "Why, in a few lines." },
        },
        required: ["ranking", "why"],
      },
      async run(input, context) {
        const member = membership(context.storage, context.conversationId);
        if (!member || member.number === CAPTAIN) throw new Error("Only a race's racers vote.");
        const { race } = member.kept;
        if (race.phase !== "voting" || !race.voters.includes(member.number)) throw new Error(`Race ${race.id} isn't asking you for a vote.`);
        if (race.votes.some(({ racer }) => racer === member.number)) throw new Error("You already voted.");
        const { ranking, why } = input as { ranking: number[]; why: string };
        const refusal = refusalOfVote(race, member.number, ranking);
        if (refusal) throw new Error(refusal);
        update(context.storage, race.id, (changed) => changed.votes.push({ racer: member.number, ranking, why: cut(why.trim(), NOTE_LIMIT) }));
        await countIfAllVoted(context.storage, race.id);
        return "Your vote is in. End your turn.";
      },
    },
  },
  async replied(started, reply, context) {
    captains.set(context.conversationId, context);
    const ended = racerEnded(context.storage, started.id, reply);
    if (!ended) return;
    if (ended.toCheck) await checkRacer(context.storage, ended.race, ended.number, ended.toCheck);
    await afterTheRace(context.storage, ended.race);
  },
  async action(item, action, context) {
    captains.set(context.conversationId, context);
    const asked = action as PageAction;
    const id = item.data.id;
    if (asked.kind === "profiles") return context.profiles();
    if (asked.kind === "start") return startFromForm(item, asked, context);
    if (asked.kind === "stop") return stopRace(id, context);
    if (asked.kind === "diff") return { diff: await racerWork(context.storage, id, asked.racer) };
    if (asked.kind === "resume") {
      resumeRace(context.storage, id).catch((error) => console.error(`race ${id} could not go on after a restart:`, error));
      return { resuming: true };
    }
    if (asked.kind === "pick") return pick(id, asked.pick, context.storage);
    if (asked.kind === "picked") return picked(id, asked.pick, context.storage);
    throw new Error("A race's page starts and stops its race, shows a racer's changes, carries it on after a restart and takes the user's pick.");
  },
  async activity(event, context) {
    await hearActivity(event, context.storage);
  },
  guidance: {
    instructions:
      "- race: when the user asks to race a task, draft the race: its form opens on the canvas, filled in with the task, the profiles (one for every racer, e.g. four of a small model, or one each to compare models; leave out any the user didn't name), the check and the vote, and the user starts it there. The racers work in git worktrees of their own, sharing a board; when they finish you hear their results, and the user picks the work to take or hands the pick to you.",
    often: "- race: when the user asks to race a task on several agents; you draft it, the user starts it.",
  },
};

export default host;
