import { isAbsolute } from "node:path";

/** Who ranks the work when the racers have finished: nobody, or the racers' vote before the pick. */
export type Decide = "captain" | "vote";

/** checking: its work ended and Race runs the race's check in its folder. */
export type RacerState = "starting" | "working" | "checking" | "finished" | "stopped" | "failed";

export type CheckOutcome = "passed" | "failed" | "timed out" | "stopped";

/** What Race's own run of the race's check in a racer's folder said. */
export interface CheckResult {
  outcome: CheckOutcome;
  /** Null when it ran out of time or was stopped. */
  exitCode: number | null;
  durationMs: number;
  /** The end of what it printed, standard output and errors together. */
  output: string;
}

export interface Racer {
  number: number;
  conversationId: string;
  /** The profile it runs on, by name. */
  profile: string;
  folder: string;
  branch: string;
  state: RacerState;
  /** What it changed since the race's base, e.g. "3 files, +40 −5"; null until known. */
  changes: string | null;
  /** The start of its last message, once its work ended. */
  said: string | null;
  startedAt: number;
  /** When its work ended, before Race checked it. */
  endedAt: number | null;
  check: CheckResult | null;
}

export interface Note {
  racer: number;
  at: number;
  text: string;
}

export interface Vote {
  racer: number;
  /** The other racers, best first. */
  ranking: number[];
  why: string;
}

export interface Standing {
  racer: number;
  points: number;
  /** The voters that ranked it first. */
  firsts: number[];
}

export interface Score {
  racer: number;
  /** 0 to 10. */
  score: number;
  why: string;
}

/** The judge of a race: its profile, its conversation once started, and what it said. */
export interface Judging {
  profile: string;
  conversationId: string | null;
  scores: Score[];
  /** Its words on the race as a whole, such as what set the best apart. */
  summary: string | null;
  /** Why it gave no scores: it couldn't start, ended its turn without, or was stopped. Null while it judges, or once it scored. */
  missed: string | null;
}

/**
 * setup: the form, which the agent may have filled in, waits for the user's Start. racing: the racers work. voting: they
 * rank each other's work. judging: a judge reads the finished racers' work and scores it. picking: it waits for the user
 * to pick the work on its page. deciding: the conversation that started the race picks, or takes what the user picked.
 * stopped: the user stopped it.
 */
export type Phase = "setup" | "racing" | "voting" | "judging" | "picking" | "deciding" | "stopped";

export interface Race {
  id: string;
  task: string;
  /** The profiles the racers were asked to run on, by racer number from 1. */
  profiles: string[];
  check: string | null;
  /** A folder of check files the racers never get, copied over each racer's work just before its check; null for none. */
  checkFiles: string | null;
  /** The captain's words on how to check the work, for the form. */
  advice: string | null;
  decide: Decide;
  /** The judge's profile the race asked for; null for none. */
  judge: string | null;
  phase: Phase;
  /** How many racers it starts. */
  size: number;
  racers: Racer[];
  board: Note[];
  /** The racers asked to vote, by number; the votes they cast; and the ones whose turn ended without one. */
  voters: number[];
  votes: Vote[];
  abstained: number[];
  standings: Standing[] | null;
  /** Null until the judge starts. */
  judging: Judging | null;
  /** What the user picked on the page, in a few words. */
  picked: string | null;
  /** The commit every racer started from, once git knows all their branches. */
  base: string | null;
  startedAt: number;
}

/** What the user, or the agent, asks a race to be. */
export interface RaceRequest {
  task: string;
  profiles: string[];
  size: number;
  check: string | null;
  checkFiles: string | null;
  decide: Decide;
  judge: string | null;
}

/** What the user picked on a race's page. */
export type RacePick = { kind: "take"; racer: number } | { kind: "combine"; racers: number[]; how: string } | { kind: "captain" };

export const NOTE_LIMIT = 2000;
export const SAID_LIMIT = 1500;
export const DIFF_LIMIT = 40_000;

export const MIN_RACERS = 2;
export const MAX_RACERS = 6;
export const DEFAULT_RACERS = 4;
export const MAX_SCORE = 10;

/** Its conversation works on the task. */
export const conversationWorks = ({ state }: Racer) => state === "starting" || state === "working";

/** Its conversation works on the task, or Race checks what it did. */
export const isWorking = (racer: Racer) => conversationWorks(racer) || racer.state === "checking";

export const cut = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

/** A short id for the race, for titles and the agent's messages. */
export const newRaceId = () => crypto.randomUUID().slice(0, 6);

export const raceTitle = (task: string) => (task.trim() ? `Race · ${cut(task.split("\n")[0]!.trim(), 50)}` : "Race");

/** Racer `number`'s profile: the profiles asked for, in turn. */
export const profileOf = (profiles: string[], number: number) => profiles[(number - 1) % profiles.length]!;

/**
 * The race the user or the agent asked for, or why it can't be one. Racers run on `profiles` in turn, or all on
 * `profile`; there are `racers` of them, else one per profile when several are named, else DEFAULT_RACERS.
 */
export function raceRequest(input: { task?: string; profile?: string; profiles?: string[]; racers?: number; check?: string; checkFiles?: string; decide?: Decide; judge?: string }): RaceRequest | string {
  const task = input.task?.trim() ?? "";
  const profiles = (input.profiles ?? (input.profile ? [input.profile] : [])).map((profile) => profile.trim()).filter(Boolean);
  if (!task) return "Say what the racers should do: the task.";
  if (profiles.length === 0) return "Name the profile the racers run on, or a profile for each racer.";
  const size = input.racers ?? (profiles.length >= MIN_RACERS ? profiles.length : DEFAULT_RACERS);
  if (!Number.isInteger(size) || size < MIN_RACERS || size > MAX_RACERS) return `A race has ${MIN_RACERS} to ${MAX_RACERS} racers.`;
  const check = input.check?.trim() || null;
  const checkFiles = input.checkFiles?.trim() || null;
  if (checkFiles && !check) return "Hidden check files need a check to run them: give the check too.";
  if (checkFiles && !isAbsolute(checkFiles)) return "Give the hidden check files' folder as a full path.";
  return { task, profiles, size, check, checkFiles, decide: input.decide === "vote" ? "vote" : "captain", judge: input.judge?.trim() || null };
}

/** A race not started yet: its form, with what the user already said, and the captain's advice on how to check the work. */
export function blankRace(request: Partial<RaceRequest>, { advice }: { advice?: string | null } = {}): Race {
  const size = request.size ?? (request.profiles && request.profiles.length >= MIN_RACERS ? request.profiles.length : DEFAULT_RACERS);
  return {
    id: newRaceId(),
    task: request.task ?? "",
    profiles: request.profiles ?? [],
    check: request.check ?? null,
    checkFiles: request.checkFiles ?? null,
    advice: advice?.trim() || null,
    decide: request.decide ?? "captain",
    judge: request.judge ?? null,
    phase: "setup",
    size,
    racers: [],
    board: [],
    voters: [],
    votes: [],
    abstained: [],
    standings: null,
    judging: null,
    picked: null,
    base: null,
    startedAt: Date.now(),
  };
}

export function racerPrompt(race: Pick<Race, "id" | "task" | "check">, number: number, of: number) {
  const check = race.check ? `\n- Before you finish, run \`${race.check}\` in your folder and make it pass; Race runs it there too once you finish.` : "";
  return `${race.task}

---
You are racer ${number} of ${of} in race ${race.id}: ${of} agents work on the task above at once, each in a git worktree and branch of its own, and this conversation works in yours. You are a team: what one of you learns helps the others.

How to work:
- First call race_board to read what the others posted, then post your plan in a line or two (race_board with post).
- Call race_board again between steps, and whenever you are stuck. Post what would help the others: the cause of a bug, a file that matters, an approach that failed and why, a test that catches it.
- When another racer's note sounds useful, read its work with race_peek and borrow what helps; go your own way where you think yours is better.
- Change only your own folder: don't edit the other racers' folders or merge their branches.${check}
- When you are done, commit your work on your branch with a one-line message, post a last note saying what you did and how you checked it, and end with a short summary.`;
}

const seconds = (ms: number) => {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
};

/** What Race's check said in a racer's folder, in a few words, e.g. "passed in 42 s". */
export function checkWords(result: CheckResult) {
  if (result.outcome === "failed") return `failed with exit code ${result.exitCode} in ${seconds(result.durationMs)}`;
  if (result.outcome === "timed out") return `ran out of time after ${seconds(result.durationMs)}`;
  return `${result.outcome} ${result.outcome === "stopped" ? "after" : "in"} ${seconds(result.durationMs)}`;
}

export function votePrompt(race: Race, voter: number) {
  const others = race.racers.filter(({ number, state }) => number !== voter && state === "finished");
  const checked = race.check
    ? `\nRace ran \`${race.check}\` in each folder:\n${others.map(({ number, check }) => `- racer ${number}: ${check ? checkWords(check) : "not run"}`).join("\n")}\n`
    : "";
  return `All racers of race ${race.id} have finished. Vote on the others' work: read each with race_peek (racers ${others.map(({ number }) => number).join(", ")}).${checked}
Then call race_vote with their numbers, best first, and why in a few lines. Don't rank yourself, and don't run long jobs: vote in this turn.`;
}

export function judgePrompt(race: Race) {
  const finished = race.racers.filter(({ state }) => state === "finished");
  return `You judge race ${race.id}: ${race.size} agents worked on the task below at once, each in a git worktree of its own. Score how well each finished racer's work does the task.

The task:

${race.task}

The racers that finished:
${finished.map((racer) => racerSummary(race, racer)).join("\n")}

How to judge:
- Read each one's work with race_peek (racers ${finished.map(({ number }) => number).join(", ")}), and its files in its folder where you need more.
- Judge it against the task: does it do all of it, correctly, and how well is it made: clear, no bigger than it needs to be, tested where the task asks. A passing check doesn't prove the task is done, and a failing one doesn't make the work worthless.
- Don't change any files, and don't run long jobs: you only read and judge, in this turn.
- Then call race_judge with a score from 0 to 10 for each of them and why in a few lines, and a summary of what set the best apart.`;
}

/**
 * Each voter's ranking gives a racer as many points as it ranked others below it, so the last gets none and a voter
 * that abstains takes nothing from anyone; the racers come out with the most points first, then the most first places,
 * then in the order they raced.
 */
export function tally(race: Pick<Race, "racers" | "votes">): Standing[] {
  const standings = new Map(race.racers.filter(({ state }) => state === "finished").map(({ number }) => [number, { racer: number, points: 0, firsts: [] as number[] }]));
  for (const { racer: voter, ranking } of race.votes) {
    ranking.forEach((racer, place) => {
      const standing = standings.get(racer);
      if (!standing) return;
      standing.points += ranking.length - 1 - place;
      if (place === 0) standing.firsts.push(voter);
    });
  }
  return [...standings.values()].sort((one, other) => other.points - one.points || other.firsts.length - one.firsts.length || one.racer - other.racer);
}

/** Two racers that each ranked the other first, the only ranking two can give. */
const eachRankedTheOtherFirst = (race: Pick<Race, "votes">, standings: Standing[]) =>
  standings.length === 2 && race.votes.length === 2 && standings.every(({ firsts }) => firsts.length === 1);

const racersWords = (numbers: number[]) => `${numbers.length === 1 ? "racer" : "racers"} ${numbers.join(", ")}`;

/** How the vote came out, in a line, e.g. "racer 3: 2 points, ranked first by racers 1, 2; …", or the tie two racers make. */
export function standingsWords(race: Pick<Race, "votes">, standings: Standing[]) {
  if (eachRankedTheOtherFirst(race, standings)) return "A tie: each ranked the other first.";
  const pointsCount = standings.some(({ points }) => points > 0);
  const line = ({ racer, points, firsts }: Standing) => {
    const parts = [...(pointsCount ? [`${points} ${points === 1 ? "point" : "points"}`] : []), ...(firsts.length > 0 ? [`ranked first by ${racersWords(firsts)}`] : [])];
    return `racer ${racer}${parts.length > 0 ? `: ${parts.join(", ")}` : ": ranked first by nobody"}`;
  };
  return `${standings.map(line).join("; ")}.`;
}

/** A voter's ranking, e.g. "ranked 3 first, then 2". */
export const rankingWords = ([first, ...rest]: number[]) => `ranked ${first} first${rest.length > 0 ? `, then ${rest.join(", ")}` : ""}`;

/** Why a ranking isn't a vote this racer can cast, or null when it is. */
export function refusalOfVote(race: Race, voter: number, ranking: number[]): string | null {
  const others = race.racers.filter(({ number, state }) => number !== voter && state === "finished").map(({ number }) => number);
  const sorted = [...ranking].sort((one, other) => one - other);
  if (sorted.length === others.length && sorted.every((racer, index) => racer === others[index])) return null;
  return `Rank each of the other racers that finished exactly once, best first: ${others.join(", ")}.`;
}

/** Why scores aren't ones this race's judge can give, or null when they are. */
export function refusalOfScores(race: Race, scores: Score[]): string | null {
  const finished = race.racers.filter(({ state }) => state === "finished").map(({ number }) => number);
  const sorted = scores.map(({ racer }) => racer).sort((one, other) => one - other);
  const eachOnce = sorted.length === finished.length && sorted.every((racer, index) => racer === finished[index]);
  const inRange = scores.every(({ score }) => Number.isInteger(score) && score >= 0 && score <= MAX_SCORE);
  if (eachOnce && inRange) return null;
  return `Score each racer that finished exactly once, from 0 to 10: ${finished.join(", ")}.`;
}

/** What the judge said of the racers' work, best first, for the captain. */
export function scoresWords(judging: Judging) {
  if (judging.scores.length === 0) return `The judge (${judging.profile}) gave no scores: ${judging.missed}.`;
  const lines = [...judging.scores]
    .sort((one, other) => other.score - one.score || one.racer - other.racer)
    .map(({ racer, score, why }) => `- Racer ${racer}: ${score}/10. ${why}`);
  return `The judge (${judging.profile}) scored their work against the task:\n${lines.join("\n")}${judging.summary ? `\n${judging.summary}` : ""}`;
}

const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
};

/** Who posted a note: a racer, or the conversation that started the race, whose notes carry racer 0. */
const authorOf = (racer: number) => (racer === 0 ? "the captain" : `racer ${racer}`);

export const racerLine = ({ number, state, changes }: Racer) => `racer ${number}: ${state}${changes ? `, ${changes}` : ""}`;

/** What race_board answers a racer: the others' notes it hasn't read yet, and where every racer stands. */
export function boardAnswer(race: Race, reader: number | null, unread: Note[], now: number) {
  const notes = unread.length === 0 ? "No new notes from the others." : unread.map((note) => `${authorOf(note.racer)} (${ago(note.at, now)}): ${note.text}`).join("\n\n");
  const you = reader === null ? "" : ` You are racer ${reader}.`;
  return `Race ${race.id} board.${you}\n\n${notes}\n\nWhere the racers are:\n${race.racers.map(racerLine).join("\n")}\n\nRead a racer's work with race_peek; post what you learn with race_board.`;
}

const baseWords = (race: Race) => race.base ?? "the commit the workspace had checked out when the race started";

function racerSummary(race: Race, racer: Racer) {
  const hidden = race.checkFiles && racer.check ? ", with the hidden check files" : "";
  const check = racer.check ? ` · check ${checkWords(racer.check)}${hidden}` : "";
  const said = racer.said ? `\n  It said: ${racer.said.replaceAll("\n", "\n  ")}` : "";
  return `- Racer ${racer.number} (${racer.profile}): ${racer.state} · branch ${racer.branch} · folder ${racer.folder} · ${racer.changes ?? "changes unknown"}${check}${said}`;
}

/** How the race ended: each racer's branch, folder, changes, check and words, the vote, and the judge's scores. */
function results(race: Race) {
  const finished = race.racers.filter(({ state }) => state === "finished");
  const vote = race.standings
    ? `\n\nThe racers voted: ${standingsWords(race, race.standings)}${race.votes.map(({ racer, ranking, why }) => `\n- Racer ${racer} ${rankingWords(ranking)}: ${why}`).join("")}`
    : "";
  const judged = race.judging && (race.judging.scores.length > 0 || race.judging.missed) ? `\n\n${scoresWords(race.judging)}` : "";
  return `Race ${race.id} is over: ${finished.length} of ${race.racers.length} racers finished. Each worked on a branch of its own, from ${baseWords(race)}:\n${race.racers.map((racer) => racerSummary(race, racer)).join("\n")}${vote}${judged}`;
}

const nobodyFinished = (race: Race) => race.racers.every(({ state }) => state !== "finished");

function nobodyFinishedPrompt(race: Race) {
  return `Race ${race.id} is over, and no racer finished its work:\n${race.racers.map((racer) => racerSummary(race, racer)).join("\n")}\n\nTell the user, and what the racers' conversations say went wrong.`;
}

const checkName = (race: Race) => (race.check ? `\`${race.check}\`` : "the project's checks");

const howToTake = (race: Race) =>
  `commit a racer's work on its branch if it left some uncommitted, then \`git merge --squash <branch>\` or \`git cherry-pick\`, or copy the parts you want. Run ${checkName(race)} again on the result`;

/** What the conversation that started the race hears when the user lets it pick the work. */
export function decidePrompt(race: Race) {
  if (nobodyFinished(race)) return nobodyFinishedPrompt(race);
  const firstStep = race.check ? `Race ran ${checkName(race)} in each finished racer's folder; what it said is above.` : `Run ${checkName(race)} in each finished racer's folder.`;
  return `${results(race)}

Now decide:
1. ${firstStep}
2. Read their work: race_peek, or \`git -C <folder> diff ${race.base ?? "<base>"}\` with \`git -C <folder> status\` for new files.
3. Take the best into your own branch, or combine the best parts: ${howToTake(race)}.
4. Tell the user which racer's work you took and why, and what the check said.`;
}

/** What the conversation that started the race hears once it's over, when the user picks the work on its page. */
export function pickingPrompt(race: Race) {
  if (nobodyFinished(race)) return nobodyFinishedPrompt(race);
  return `${results(race)}

The user picks the work to take on the race page and will tell you what to take. Don't merge or change anything until then: answer in one line that race ${race.id} is over and waits for their pick.`;
}

/** What the user's pick on the page sends the conversation that started the race, as their own message. */
export function pickMessage(race: Race, pick: RacePick): string {
  if (pick.kind === "captain") return decidePrompt(race);
  const racers = pick.kind === "take" ? [pick.racer] : pick.racers;
  const chosen = racers.map((number) => race.racers.find((racer) => racer.number === number && racer.state === "finished"));
  if (chosen.some((racer) => !racer)) throw new Error(`Pick among the racers that finished: ${race.racers.filter(({ state }) => state === "finished").map(({ number }) => number).join(", ")}.`);
  const lines = (chosen as Racer[]).map((racer) => racerSummary(race, racer)).join("\n");
  const from = `They started from ${baseWords(race)}.`;
  if (pick.kind === "take") {
    return `Take racer ${pick.racer}'s work from race ${race.id} into your branch:\n${lines}\n${from}\nTo take it, ${howToTake(race)}, and tell me what it said.`;
  }
  if (racers.length < 2) throw new Error("Pick at least two racers to combine.");
  const how = pick.how.trim() ? `\n\nHow to combine them: ${pick.how.trim()}` : "";
  return `Combine the work of racers ${racers.join(", ")} from race ${race.id} in your branch:\n${lines}\n${from}${how}\n\nRead each with race_peek or \`git -C <folder> diff ${race.base ?? "<base>"}\`, take the parts that fit together, run ${checkName(race)} on the result, and tell me what you took from each and what the check said.`;
}

/** The pick in a few words, for the page. */
export function pickWords(pick: RacePick) {
  if (pick.kind === "take") return `You took racer ${pick.racer}'s work`;
  if (pick.kind === "combine") return `You asked to combine racers ${pick.racers.join(", ")}`;
  return "You let the captain pick";
}
