import { existsSync } from "node:fs";
import type { CanvasActionContext, CanvasHost, CanvasPluginContext, CanvasPluginStorage, CanvasToolContext, ConversationReply, PluginActivityEvent } from "./mirador/api.ts";
import { changesOf, diffOf, raceBase } from "./git.ts";
import {
  DEFAULT_RACERS,
  DIFF_LIMIT,
  MAX_RACERS,
  MIN_RACERS,
  NOTE_LIMIT,
  SAID_LIMIT,
  boardAnswer,
  cut,
  decidePrompt,
  isWorking,
  newRaceId,
  raceTitle,
  racerPrompt,
  refusalOfVote,
  tally,
  votePrompt,
  type Decide,
  type Race,
  type Racer,
} from "./race.ts";

export const ITEM_TYPE = "race";

/** The racer number a note of the conversation that started the race carries. */
export const CAPTAIN = 0;

/** A changed file shows on the race page within this long of a racer's tool call. */
const CHANGES_REFRESH_MS = 5_000;

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
  task: string;
  profile: string;
  racers?: number;
  check?: string;
  decide?: Decide;
}

const raceKey = (id: string) => `race:${id}`;
const racerKey = (conversationId: string) => `racer:${conversationId}`;
const readKey = (conversationId: string) => `read:${conversationId}`;
const RACES = "races";

/** The conversations' contexts this run of Mirador has seen: the captain's to change its race page and tell it, a racer's to ask for its vote. */
const captains = new Map<string, CanvasPluginContext<Race> & { prompt: CanvasActionContext["prompt"] }>();
const racerContexts = new Map<string, CanvasToolContext<Race>>();
const refreshes = new Map<string, { running: boolean; last: number }>();

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

const notAMember = () => new Error("Only a race's racers and the conversation that started it use the race tools; start a race with the race tool.");

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

function startedRacer(number: number, started: { id: string; worktree?: { folder: string; branch: string } }): Racer {
  if (!started.worktree) throw new Error("This Mirador started a racer without a worktree of its own; race needs Mirador's plugin API 12.");
  return { number, conversationId: started.id, folder: started.worktree.folder, branch: started.worktree.branch, state: "starting", changes: null, said: null };
}

/**
 * The first racer starts before anything shows, as it is the one a workspace outside git refuses; then the race page,
 * which every racer after it joins as it starts. One that can't start stops the race.
 */
async function startRace(input: RaceInput, context: CanvasToolContext<Race>) {
  const size = input.racers ?? DEFAULT_RACERS;
  const race: Race = {
    id: newRaceId(),
    task: input.task.trim(),
    profile: input.profile,
    check: input.check?.trim() || null,
    decide: input.decide ?? "captain",
    phase: "racing",
    size,
    racers: [],
    board: [],
    voters: [],
    votes: [],
    abstained: [],
    standings: null,
    base: null,
    startedAt: Date.now(),
  };
  const start = async (number: number) => {
    const started = await context.startConversation({ profile: input.profile, prompt: racerPrompt(race, number, size), title: `Race ${race.id} · racer ${number}`, worktree: "own" });
    context.storage.set(racerKey(started.id), { race: race.id, number } satisfies KeptRacer);
    return { ...startedRacer(number, started), profile: started.profile };
  };
  const { profile, ...first } = await start(1);
  race.profile = profile;
  race.racers.push(first);
  const item = context.publish({ type: ITEM_TYPE, title: raceTitle(race.task), data: race });
  captains.set(context.conversationId, context);
  context.storage.set(raceKey(race.id), { race, captain: context.conversationId, itemId: item.id } satisfies KeptRace);
  context.storage.set(RACES, [...raceIds(context.storage), race.id]);
  for (let number = 2; number <= size; number++) {
    try {
      const { profile: _, ...racer } = await start(number);
      update(context.storage, race.id, (changed) => changed.racers.push(racer));
    } catch (error) {
      update(context.storage, race.id, (changed) => (changed.phase = "stopped"));
      await Promise.all(keptRace(context.storage, race.id)!.race.racers.map(({ conversationId }) => context.stopConversation(conversationId).catch(() => {})));
      throw error;
    }
  }
  return keptRace(context.storage, race.id)!.race;
}

/** Once every racer's work has ended: the vote if the race asked for one and some racers can cast it, else the captain decides. */
async function afterTheRace(storage: CanvasPluginStorage, id: string) {
  await refreshChanges(storage, id, { now: true });
  const kept = keptRace(storage, id);
  if (!kept || kept.race.racers.length < kept.race.size || kept.race.racers.some(isWorking) || kept.race.phase !== "racing") return;
  const finished = kept.race.racers.filter(({ state }) => state === "finished");
  const voters = kept.race.decide === "vote" && finished.length > 1 ? finished.filter(({ conversationId }) => racerContexts.has(conversationId)) : [];
  if (voters.length === 0) return askCaptainToDecide(storage, id);
  update(storage, id, (race) => {
    race.phase = "voting";
    race.voters = voters.map(({ number }) => number);
  });
  for (const { conversationId, number } of voters) {
    await racerContexts.get(conversationId)!.prompt(votePrompt(kept.race, number), { afterTurn: true });
  }
}

async function askCaptainToDecide(storage: CanvasPluginStorage, id: string) {
  const kept = update(storage, id, (race) => {
    if (race.votes.length > 0) race.standings = tally(race);
    race.phase = "deciding";
  });
  if (!kept) return;
  const captain = captains.get(kept.captain);
  if (!captain) {
    console.error(`race ${id} is over, but Mirador was restarted since it started and can't tell the conversation that started it.`);
    return;
  }
  await captain.prompt(decidePrompt(kept.race), { afterTurn: true });
}

/** Every voter voted, or ended its turn without: the captain decides, with the standings. */
async function countIfAllVoted(storage: CanvasPluginStorage, id: string) {
  const race = keptRace(storage, id)?.race;
  if (!race || race.phase !== "voting") return;
  const heard = new Set([...race.votes.map(({ racer }) => racer), ...race.abstained]);
  if (race.voters.every((voter) => heard.has(voter))) await askCaptainToDecide(storage, id);
}

function racerEnded(storage: CanvasPluginStorage, conversationId: string, reply: ConversationReply) {
  const racer = keptRacer(storage, conversationId);
  if (!racer) return null;
  update(storage, racer.race, (race) => {
    const ended = race.racers.find(({ number }) => number === racer.number);
    if (!ended) return;
    ended.state = reply.ended;
    ended.said = reply.text === null ? null : cut(reply.text.trim(), SAID_LIMIT);
  });
  return racer.race;
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

const host: CanvasHost<Race> = {
  items: {
    [ITEM_TYPE]: {
      icon: "⚑",
      placement: "page",
      outcome: (race) => {
        if (race.phase === "racing") return `${race.racers.filter((racer) => !isWorking(racer)).length}/${race.racers.length} done`;
        if (race.phase === "voting") return `voting ${race.votes.length}/${race.voters.length}`;
        return race.phase;
      },
    },
  },
  tools: {
    race: {
      description:
        "Race a task: start several conversations on one profile, e.g. four of a small model, each in a git worktree and branch of its own, working on the same task at once and sharing a board where they post what they learn. Returns at once; when all have finished you hear it as your next message, with their branches and folders, to run the check in each, pick or combine the best work and merge it. With decide: vote, the racers rank each other's work first. Racers branch from the last commit, so commit what they need first; the workspace's worktree setup command, such as installing dependencies, runs in each racer's folder before it starts.",
      command: { description: "Race a task on several agents of one profile" },
      input: {
        type: "object",
        properties: {
          task: { type: "string", minLength: 1, description: "Everything the racers need: what to do, which files or commands, and how to tell it works. They see nothing of this conversation." },
          profile: { type: "string", minLength: 1, description: "The Mirador profile every racer runs on, by name." },
          racers: { type: "integer", minimum: MIN_RACERS, maximum: MAX_RACERS, description: `How many racers; ${DEFAULT_RACERS} unless the user names another number.` },
          check: { type: "string", minLength: 1, description: "A command that tells whether the work is right, e.g. the project's tests; each racer runs it before it finishes." },
          decide: { type: "string", enum: ["captain", "vote"], description: "captain (the default): you pick once they finish. vote: the racers first rank each other's work, then you pick." },
        },
        required: ["task", "profile"],
      },
      async run(input, context) {
        const race = await startRace(input as RaceInput, context);
        const branches = race.racers.map(({ number, branch }) => `racer ${number} on ${branch}`).join(", ");
        return `Race ${race.id} started: ${race.racers.length} racers on ${race.profile}, each in a worktree of its own (${branches}). They share a board you can read with race_board, and post to, to steer them. When all have finished, you hear it as your next message; carry on with other work meanwhile, or end your turn.`;
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
        const { racer: number } = input as { racer: number };
        const racer = member.kept.race.racers.find((each) => each.number === number);
        if (!racer) throw new Error(`Race ${member.kept.race.id} has racers 1 to ${member.kept.race.racers.length}.`);
        await refreshChanges(context.storage, member.kept.race.id, { now: true });
        const base = keptRace(context.storage, member.kept.race.id)!.race.base;
        if (!base || !existsSync(racer.folder)) return `Racer ${number} hasn't started yet; look again in a minute.`;
        const diff = await diffOf(racer.folder, base);
        if (!diff.trim()) return `Racer ${number} hasn't changed anything yet.`;
        return diff.length <= DIFF_LIMIT ? diff : `${diff.slice(0, DIFF_LIMIT)}\n\n[Cut at ${DIFF_LIMIT} characters; the whole work is in ${racer.folder}.]`;
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
    const id = racerEnded(context.storage, started.id, reply);
    if (id) await afterTheRace(context.storage, id);
  },
  async action(item, action, context) {
    if ((action as { kind?: unknown }).kind !== "stop") throw new Error("A race's page can only stop it.");
    captains.set(context.conversationId, context);
    const id = (item.data as Race).id;
    const kept = update(context.storage, id, (race) => {
      if (race.phase === "racing") race.phase = "stopped";
    });
    if (!kept) throw new Error("This race is no longer kept.");
    await Promise.all(kept.race.racers.filter(isWorking).map(({ conversationId }) => context.stopConversation(conversationId)));
    return { stopped: true };
  },
  async activity(event, context) {
    await hearActivity(event, context.storage);
  },
  guidance: {
    instructions:
      "- race: when the user asks to race a task, start several conversations on one profile (e.g. four of a small model), each in a git worktree of its own, sharing a board where they post what they learn; when they finish you hear it, then run the check in each worktree, pick or combine the best work and merge it into your branch.",
    often: "- race: when the user asks to race a task on several agents.",
  },
};

export default host;
