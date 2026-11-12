/** Who decides when the racers have finished: the conversation that started the race, or the racers' vote and then it. */
export type Decide = "captain" | "vote";

export type RacerState = "starting" | "working" | "finished" | "stopped" | "failed";

export interface Racer {
  number: number;
  conversationId: string;
  folder: string;
  branch: string;
  state: RacerState;
  /** What it changed since the race's base, e.g. "3 files, +40 −5"; null until known. */
  changes: string | null;
  /** The start of its last message, once its work ended. */
  said: string | null;
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
}

/**
 * racing: the racers work. voting: they rank each other's work. deciding: the conversation that started the race was
 * told to pick. stopped: the user stopped it.
 */
export type Phase = "racing" | "voting" | "deciding" | "stopped";

export interface Race {
  id: string;
  task: string;
  profile: string;
  check: string | null;
  decide: Decide;
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
  /** The commit every racer started from, once git knows all their branches. */
  base: string | null;
  startedAt: number;
}

export const NOTE_LIMIT = 2000;
export const SAID_LIMIT = 1500;
export const DIFF_LIMIT = 40_000;

export const MIN_RACERS = 2;
export const MAX_RACERS = 6;
export const DEFAULT_RACERS = 4;

export const isWorking = ({ state }: Racer) => state === "starting" || state === "working";

export const cut = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

/** A short id for the race, for titles and the agent's messages. */
export const newRaceId = () => crypto.randomUUID().slice(0, 6);

export const raceTitle = (task: string) => `Race · ${cut(task.split("\n")[0]!.trim(), 50)}`;

export function racerPrompt(race: Pick<Race, "id" | "task" | "check">, number: number, of: number) {
  const check = race.check ? `\n- Before you finish, run \`${race.check}\` in your folder and make it pass.` : "";
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

export function votePrompt(race: Race, voter: number) {
  const others = race.racers.filter(({ number, state }) => number !== voter && state === "finished");
  const folders = others.map(({ number, folder }) => `racer ${number}: ${folder}`).join("\n");
  const check = race.check ? ` You may run \`${race.check}\` in their folders:\n${folders}\n` : "";
  return `All racers of race ${race.id} have finished. Vote on the others' work: read each with race_peek (racers ${others.map(({ number }) => number).join(", ")}).${check}
Then call race_vote with their numbers, best first, and why in a few lines. Don't rank yourself.`;
}

/**
 * Each voter's ranking gives the racer it puts first as many points as it ranked others below it, and the last none; the
 * racers come out with the most points first, a tie in the order they raced.
 */
export function tally(race: Pick<Race, "racers" | "votes">): Standing[] {
  const points = new Map(race.racers.filter(({ state }) => state === "finished").map(({ number }) => [number, 0]));
  for (const { ranking } of race.votes) {
    ranking.forEach((racer, place) => points.set(racer, (points.get(racer) ?? 0) + ranking.length - 1 - place));
  }
  return [...points].map(([racer, points]) => ({ racer, points })).sort((one, other) => other.points - one.points || one.racer - other.racer);
}

/** Why a ranking isn't a vote this racer can cast, or null when it is. */
export function refusalOfVote(race: Race, voter: number, ranking: number[]): string | null {
  const others = race.racers.filter(({ number, state }) => number !== voter && state === "finished").map(({ number }) => number);
  const sorted = [...ranking].sort((one, other) => one - other);
  if (sorted.length === others.length && sorted.every((racer, index) => racer === others[index])) return null;
  return `Rank each of the other racers that finished exactly once, best first: ${others.join(", ")}.`;
}

const stateWords: Record<RacerState, string> = {
  starting: "starting",
  working: "working",
  finished: "finished",
  stopped: "stopped",
  failed: "failed",
};

const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
};

/** Who posted a note: a racer, or the conversation that started the race, whose notes carry racer 0. */
const authorOf = (racer: number) => (racer === 0 ? "the captain" : `racer ${racer}`);

const pointsWords = (points: number) => `${points} ${points === 1 ? "point" : "points"}`;

export const racerLine = ({ number, state, changes }: Racer) => `racer ${number}: ${stateWords[state]}${changes ? `, ${changes}` : ""}`;

/** What race_board answers a racer: the others' notes it hasn't read yet, and where every racer stands. */
export function boardAnswer(race: Race, reader: number | null, unread: Note[], now: number) {
  const notes = unread.length === 0 ? "No new notes from the others." : unread.map((note) => `${authorOf(note.racer)} (${ago(note.at, now)}): ${note.text}`).join("\n\n");
  const you = reader === null ? "" : ` You are racer ${reader}.`;
  return `Race ${race.id} board.${you}\n\n${notes}\n\nWhere the racers are:\n${race.racers.map(racerLine).join("\n")}\n\nRead a racer's work with race_peek; post what you learn with race_board.`;
}

/** What the conversation that started the race hears once the racers have finished, and the vote if there was one. */
export function decidePrompt(race: Race) {
  const finished = race.racers.filter(({ state }) => state === "finished");
  const lines = race.racers.map((racer) => {
    const said = racer.said ? `\n  It said: ${racer.said.replaceAll("\n", "\n  ")}` : "";
    return `- Racer ${racer.number}: ${stateWords[racer.state]} · branch ${racer.branch} · folder ${racer.folder} · ${racer.changes ?? "changes unknown"}${said}`;
  });
  const base = race.base ?? "the commit the workspace had checked out when the race started";
  const vote = race.standings ? `\n\nThe racers voted: ${race.standings.map(({ racer, points }) => `racer ${racer} ${pointsWords(points)}`).join(", ")}.${race.votes.map(({ racer, why }) => `\n- Racer ${racer}: ${why}`).join("")}` : "";
  const check = race.check ? `\`${race.check}\`` : "the project's checks";
  if (finished.length === 0) {
    return `Race ${race.id} is over, and no racer finished its work:\n${lines.join("\n")}\n\nTell the user, and what the racers' conversations say went wrong.`;
  }
  return `Race ${race.id} is over: ${finished.length} of ${race.racers.length} racers finished. Each worked on a branch of its own, from ${base}:\n${lines.join("\n")}${vote}

Now decide:
1. Run ${check} in each finished racer's folder.
2. Read their work: race_peek, or \`git -C <folder> diff ${race.base ?? "<base>"}\` with \`git -C <folder> status\` for new files.
3. Take the best into your own branch, or combine the best parts: commit a racer's work on its branch if it left some uncommitted, then \`git merge --squash <branch>\` or \`git cherry-pick\`, or copy the parts you want. Run the check again on the result.
4. Tell the user which racer's work you took and why, and what the check said.`;
}
