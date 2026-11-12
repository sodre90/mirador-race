import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import host, { ITEM_TYPE } from "../host.ts";
import type { CanvasActionContext, CanvasPluginStorage, CanvasToolContext, ConversationReply, PluginActivity, PluginItem } from "../mirador/api.ts";
import { runCheck, CheckQueue, type RunningCheck } from "../check.ts";
import { tally, type CheckResult, type Race } from "../race.ts";

let scratch: string;
let repo: string;

async function git(folder: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout;
}

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "race-test-")));
  repo = join(scratch, "project");
  await mkdir(repo);
  await git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
  writeFileSync(join(repo, "app.ts"), "export const answer = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "base"]);
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

type Context = CanvasToolContext<Race> & CanvasActionContext<Race>;

const PROFILES = [
  { name: "Qwen Flash", agent: "opencode" },
  { name: "Kimi", agent: "claude" },
];

/** Mirador as the plugin sees it: one storage, the items of each conversation, and conversations started in real worktrees of the repo. */
function fakeMirador({ refuseRacer, caller = "agent" }: { refuseRacer?: number; caller?: "agent" | "user" } = {}) {
  const kept = new Map<string, string>();
  const storage: CanvasPluginStorage = {
    get: (key) => (kept.has(key) ? JSON.parse(kept.get(key)!) : undefined),
    set: (key, value) => (value === undefined ? kept.delete(key) : kept.set(key, JSON.stringify(value))),
  };
  const items: (PluginItem<Race> & { conversationId: string })[] = [];
  const prompts: { conversationId: string; text: string; afterTurn: boolean }[] = [];
  const stopped: string[] = [];
  const started: { id: string; profile: string; prompt: string; title?: string; folder: string; branch: string }[] = [];
  const contextOf = (conversationId: string): Context => ({
    conversationId,
    caller,
    storage,
    profiles: () => PROFILES,
    items: () => items.filter((item) => item.conversationId === conversationId),
    change(itemId, { title, data }) {
      const item = items.find((each) => each.id === itemId && each.conversationId === conversationId);
      if (!item) throw new Error(`No item ${itemId} in ${conversationId}.`);
      if (title) item.title = title;
      if (data) item.data = structuredClone(data);
      return item;
    },
    profileSetting: () => null,
    publish({ type, title, data }) {
      const item = { id: `item-${items.length + 1}`, type, title, data: structuredClone(data), createdAt: Date.now(), dismissed: false, agentEditedAt: null, conversationId };
      items.push(item);
      return item;
    },
    async prompt(text, { afterTurn = false } = {}) {
      prompts.push({ conversationId, text, afterTurn });
    },
    async startConversation({ profile: asked, prompt, title, worktree }) {
      if (worktree !== "own") throw new Error("The race asked for no worktree of its own.");
      const profile = PROFILES.find(({ name }) => name.toLowerCase() === asked.toLowerCase())?.name;
      if (!profile) throw new Error(`There is no profile named ${asked}.`);
      if (refuseRacer === started.length + 1) throw new Error("A conversation gets its own worktree only in a git repository with a commit.");
      const id = crypto.randomUUID();
      const short = id.slice(0, 8);
      const folder = join(scratch, "worktrees", short);
      const branch = `mirador/${short}`;
      await git(repo, ["worktree", "add", "-q", "-b", branch, folder, "HEAD"]);
      started.push({ id, profile, prompt, ...(title && { title }), folder, branch });
      return { id, profile, worktree: { folder, branch } };
    },
    async stopConversation(id) {
      stopped.push(id);
    },
    openInEditor() {},
  });
  const captain = contextOf(crypto.randomUUID());
  const call = async (context: Context, tool: string, input: Record<string, unknown>) => host.tools[tool]!.run(input, context);
  const page = () => items.find((item) => item.type === ITEM_TYPE && item.conversationId === captain.conversationId)!.data;
  const racer = (number: number) => contextOf(started[number - 1]!.id);
  const replied = (number: number, reply: ConversationReply) => host.replied!({ id: started[number - 1]!.id, profile: started[number - 1]!.profile }, reply, captain);
  const raceItem = () => items.find((item) => item.type === ITEM_TYPE && item.conversationId === captain.conversationId)!;
  const act = (action: Record<string, unknown>) => host.action!(raceItem(), action, captain);
  const heard = (number: number, activity: PluginActivity) =>
    host.activity!({ ...activity, conversationId: started[number - 1]!.id, conversationTitle: "", at: Date.now() } as never, { storage, windowChanged() {}, profileSetting: () => null });
  const promptsTo = (conversationId: string) => prompts.filter((prompt) => prompt.conversationId === conversationId);
  return { captain, contextOf, call, page, racer, replied, heard, prompts, promptsTo, stopped, started, items, raceItem, act };
}

const finished = (text: string): ConversationReply => ({ text, ended: "finished" });

test("a race starts its racers on one profile, each in a worktree of its own with its number, and shows them on a page", async () => {
  const mirador = fakeMirador();

  const answer = await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "qwen flash", racers: 3, check: "bun test" });
  expect(mirador.started.map(({ profile }) => profile)).toEqual(["Qwen Flash", "Qwen Flash", "Qwen Flash"]);

  expect(mirador.started).toHaveLength(3);
  expect(new Set(mirador.started.map(({ folder }) => folder)).size).toBe(3);
  expect(mirador.started[1]!.prompt).toContain("You are racer 2 of 3");
  expect(mirador.started[1]!.prompt).toContain("Make answer 42");
  expect(mirador.started[1]!.prompt).toContain("run `bun test` in your folder and make it pass.\n");
  expect(mirador.started[0]!.title).toMatch(/^Race [0-9a-f]{6} · racer 1$/);
  const race = mirador.page();
  expect(race).toMatchObject({ task: "Make answer 42", profiles: ["qwen flash"], size: 3, phase: "racing", decide: "captain", check: "bun test", startedByUser: false });
  expect(race.racers.map(({ number, branch, state, profile }) => ({ number, branch, state, profile }))).toEqual(
    mirador.started.map(({ branch }, index) => ({ number: index + 1, branch, state: "starting", profile: "Qwen Flash" })),
  );
  expect(answer).toContain(`Race ${race.id} started: 3 racers, each in a worktree of its own (racer 1 on Qwen Flash, branch ${mirador.started[0]!.branch};`);
  expect(answer).toContain("you hear it as your next message");
});

test("a workspace that can't give the first racer a worktree starts no race and says why", async () => {
  const mirador = fakeMirador({ refuseRacer: 1 });

  await expect(mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash" })).rejects.toThrow("only in a git repository");
  expect(mirador.items).toEqual([]);
});

test("a racer that can't start stops the ones that did, and the race shows as stopped", async () => {
  const mirador = fakeMirador({ refuseRacer: 3 });

  await expect(mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 4 })).rejects.toThrow();

  expect(mirador.stopped).toEqual(mirador.started.map(({ id }) => id));
  expect(mirador.page().phase).toBe("stopped");
});

test("racers share a board: each reads the others' notes it hasn't read, the captain reads them all, and the page shows them with each racer's changes", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3 });
  writeFileSync(join(mirador.started[0]!.folder, "notes.md"), "the answer lives in app.ts\n");

  await mirador.call(mirador.racer(1), "race_board", { post: "Plan: change app.ts" });
  const second = await mirador.call(mirador.racer(2), "race_board", { post: "Plan: add a test first" });
  const again = await mirador.call(mirador.racer(2), "race_board", {});
  const captain = await mirador.call(mirador.captain, "race_board", {});

  expect(second).toContain("You are racer 2.");
  expect(second).toContain("racer 1 (just now): Plan: change app.ts");
  expect(second).not.toContain("Plan: add a test first");
  expect(second).toContain("racer 1: starting, 1 file, +1 −0");
  expect(again).toContain("No new notes from the others.");
  expect(captain).toContain("Plan: change app.ts");
  expect(captain).toContain("Plan: add a test first");
  expect(mirador.page().board.map(({ racer, text }) => ({ racer, text }))).toEqual([
    { racer: 1, text: "Plan: change app.ts" },
    { racer: 2, text: "Plan: add a test first" },
  ]);
  expect(mirador.page().racers.map(({ changes }) => changes)).toEqual(["1 file, +1 −0", "no changes", "no changes"]);
});

test("the captain can steer the racers through the board", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });

  await mirador.call(mirador.captain, "race_board", { post: "Keep the public API as it is." });

  expect(await mirador.call(mirador.racer(1), "race_board", {})).toContain("the captain (just now): Keep the public API as it is.");
});

test("a racer peeks at another's work, committed, changed and new, without touching that racer's staging", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  const { folder } = mirador.started[0]!;
  writeFileSync(join(folder, "app.ts"), "export const answer = 42;\n");
  await git(folder, ["commit", "-qam", "answer"]);
  writeFileSync(join(folder, "app.ts"), "export const answer = 42; // checked\n");
  writeFileSync(join(folder, "app.test.ts"), "test answer\n");
  const statusBefore = await git(folder, ["status", "--porcelain"]);

  const diff = await mirador.call(mirador.racer(2), "race_peek", { racer: 1 });

  expect(diff).toContain("-export const answer = 1;");
  expect(diff).toContain("+export const answer = 42; // checked");
  expect(diff).toContain("+++ b/app.test.ts");
  expect(await git(folder, ["status", "--porcelain"])).toBe(statusBefore);
  expect(await mirador.call(mirador.racer(1), "race_peek", { racer: 2 })).toBe("Racer 2 hasn't changed anything yet.");
  await expect(mirador.call(mirador.racer(1), "race_peek", { racer: 5 })).rejects.toThrow("has racers 1 to 2");
});

test("only a race's racers and captain use its board", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });

  await expect(mirador.call(mirador.contextOf("stranger"), "race_board", { post: "hi" })).rejects.toThrow("Only a race's racers");
});

test("once every racer's work ended, the captain hears each one's branch, folder, changes and words, and to run the agent's check, which Race doesn't run itself", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3, check: "touch ran-by-race" });
  writeFileSync(join(mirador.started[0]!.folder, "app.ts"), "export const answer = 42;\n");

  await mirador.replied(1, finished("Changed app.ts; the check passes."));
  await mirador.replied(2, { text: null, ended: "failed" });
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
  await mirador.replied(3, finished("Done."));

  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  const race = mirador.page();
  expect(told?.afterTurn).toBe(true);
  expect(told?.text).toContain(`Race ${race.id} is over: 2 of 3 racers finished.`);
  expect(told?.text).toContain(`- Racer 1 (Qwen Flash): finished · branch ${mirador.started[0]!.branch} · folder ${mirador.started[0]!.folder} · 1 file, +1 −1\n`);
  expect(told?.text).toContain("It said: Changed app.ts; the check passes.");
  expect(told?.text).toContain("- Racer 2 (Qwen Flash): failed");
  expect(told?.text).toContain("1. Run `touch ran-by-race` in each finished racer's folder.");
  expect(told?.text).toContain(race.base!);
  expect(race.phase).toBe("deciding");
  expect(race.racers.map(({ check, state }) => ({ check, state }))).toEqual([
    { check: null, state: "finished" },
    { check: null, state: "failed" },
    { check: null, state: "finished" },
  ]);
  expect(mirador.started.some(({ folder }) => existsSync(join(folder, "ran-by-race"))), "the agent's check runs only where Mirador's permissions ask").toBe(false);
  expect(race.racers.map(({ endedAt }) => endedAt !== null)).toEqual([true, true, true]);
});

test("Race runs the check the user typed in each racer's folder once it finished, and the captain hears what it said with the results", async () => {
  const mirador = fakeMirador({ caller: "user" });
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3, check: "grep 42 app.ts || { echo 'no 42 here'; exit 3; }" });
  expect(mirador.started[0]!.prompt).toContain("and make it pass; Race runs it there too once you finish.");
  writeFileSync(join(mirador.started[0]!.folder, "app.ts"), "export const answer = 42;\n");

  await mirador.replied(1, finished("Changed app.ts; the check passes."));
  await mirador.replied(2, { text: null, ended: "failed" });
  await mirador.replied(3, finished("Done."));

  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  const race = mirador.page();
  expect(told?.text).toMatch(new RegExp(`- Racer 1 \\(Qwen Flash\\): finished · branch ${mirador.started[0]!.branch} · folder ${RegExp.escape(mirador.started[0]!.folder)} · 1 file, \\+1 −1 · check passed in [\\d.]+ s`));
  expect(told?.text).toMatch(/- Racer 3 \(Qwen Flash\): finished · .* · check failed with exit code 3 in [\d.]+ s/);
  expect(race.phase).toBe("picking");
  expect(race.racers.map(({ check }) => check && { outcome: check.outcome, exitCode: check.exitCode, output: check.output })).toEqual([
    { outcome: "passed", exitCode: 0, output: "export const answer = 42;\n" },
    null,
    { outcome: "failed", exitCode: 3, output: "no 42 here\n" },
  ]);
  const { message } = (await mirador.act({ kind: "pick", pick: { kind: "captain" } })) as { message: string };
  expect(message).toContain("1. Race ran `grep 42 app.ts || { echo 'no 42 here'; exit 3; }` in each finished racer's folder; what it said is above.");
});

test("with a vote, the finished racers rank each other's work first, and the captain hears the standings and their reasons", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3, decide: "vote" });
  for (const number of [1, 2, 3]) await mirador.call(mirador.racer(number), "race_board", {});
  for (const number of [1, 2, 3]) await mirador.replied(number, finished(`Racer ${number} done.`));

  expect(mirador.page().phase).toBe("voting");
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
  const [asked] = mirador.promptsTo(mirador.started[0]!.id);
  expect(asked).toMatchObject({ afterTurn: true });
  expect(asked?.text).toContain("race_peek (racers 2, 3)");

  await expect(mirador.call(mirador.racer(1), "race_vote", { ranking: [1, 2], why: "mine" })).rejects.toThrow("Rank each of the other racers that finished exactly once, best first: 2, 3.");
  await mirador.call(mirador.racer(1), "race_vote", { ranking: [3, 2], why: "3 has a test" });
  await expect(mirador.call(mirador.racer(1), "race_vote", { ranking: [3, 2], why: "again" })).rejects.toThrow("You already voted.");
  await mirador.call(mirador.racer(2), "race_vote", { ranking: [3, 1], why: "3 is simplest" });
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
  await mirador.call(mirador.racer(3), "race_vote", { ranking: [1, 2], why: "1 is close" });

  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  expect(mirador.page().standings).toEqual([
    { racer: 3, points: 2, firsts: [1, 2] },
    { racer: 1, points: 1, firsts: [3] },
    { racer: 2, points: 0, firsts: [] },
  ]);
  expect(told?.text).toContain("The racers voted: racer 3: 2 points, ranked first by racers 1, 2; racer 1: 1 point, ranked first by racer 3; racer 2: 0 points.");
  expect(told?.text).toContain("- Racer 1 ranked 3 first, then 2: 3 has a test");
  expect(mirador.page().phase).toBe("deciding");
});

test("a racer whose vote turn ends without a vote abstains, and the vote ends without it", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3, decide: "vote" });
  for (const number of [1, 2, 3]) await mirador.call(mirador.racer(number), "race_board", {});
  for (const number of [1, 2, 3]) await mirador.replied(number, finished("done"));

  await mirador.heard(3, { kind: "turn-ended", ended: "finished" });
  expect(mirador.page().abstained).toEqual([]);
  await mirador.call(mirador.racer(1), "race_vote", { ranking: [2, 3], why: "2" });
  await mirador.call(mirador.racer(2), "race_vote", { ranking: [1, 3], why: "1" });
  await mirador.heard(3, { kind: "turn-started" });
  await mirador.heard(3, { kind: "turn-ended", ended: "finished" });

  expect(mirador.page().abstained).toEqual([3]);
  expect(mirador.promptsTo(mirador.captain.conversationId)[0]?.text).toContain("The racers voted:");
});

test("a vote no racer can be asked for leaves the pick to the captain", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, decide: "vote" });

  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  expect(mirador.page().phase).toBe("deciding");
  expect(mirador.promptsTo(mirador.captain.conversationId)[0]?.text).not.toContain("The racers voted");
});

test("the page's Stop stops every racer still working, and a stopped race tells the captain nothing", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3 });
  await mirador.replied(1, finished("done"));
  const item = mirador.items.find(({ type }) => type === ITEM_TYPE)!;

  expect(await host.action!(item, { kind: "stop" }, mirador.captain)).toEqual({ stopped: true });
  for (const number of [2, 3]) await mirador.replied(number, { text: null, ended: "stopped" });

  expect(mirador.stopped).toEqual([mirador.started[1]!.id, mirador.started[2]!.id]);
  expect(mirador.page().phase).toBe("stopped");
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
});

test("a racer's first turn marks it working on the page", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });

  await mirador.heard(2, { kind: "turn-started" });

  expect(mirador.page().racers.map(({ state }) => state)).toEqual(["starting", "working"]);
});

test("the tally gives a voter's first pick a point for each racer it ranked below, and breaks a tie by racer number", () => {
  const racers = [1, 2, 3, 4].map((number) => ({ number, state: number === 4 ? ("failed" as const) : ("finished" as const) })) as Race["racers"];

  expect(
    tally({
      racers,
      votes: [
        { racer: 1, ranking: [2, 3], why: "" },
        { racer: 2, ranking: [3, 1], why: "" },
        { racer: 3, ranking: [2, 1], why: "" },
      ],
    }),
  ).toEqual([
    { racer: 2, points: 2, firsts: [1, 3] },
    { racer: 3, points: 1, firsts: [2] },
    { racer: 1, points: 0, firsts: [] },
  ]);
});

const until = async (condition: () => boolean, what: string) => {
  for (let tries = 0; tries < 400 && !condition(); tries++) await Bun.sleep(10);
  if (!condition()) throw new Error(`Never came: ${what}`);
};

test("racers can run on a profile each, which repeat in turn when there are more racers", async () => {
  const mirador = fakeMirador();

  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profiles: ["qwen flash", "kimi"], racers: 3 });

  expect(mirador.started.map(({ profile }) => profile)).toEqual(["Qwen Flash", "Kimi", "Qwen Flash"]);
  expect(mirador.page().racers.map(({ profile }) => profile)).toEqual(["Qwen Flash", "Kimi", "Qwen Flash"]);
  await mirador.call(mirador.captain, "race", { task: "Compare them", profiles: ["Kimi", "Qwen Flash"] });
  expect(mirador.started.slice(3).map(({ profile }) => profile), "one racer per profile when several are named").toEqual(["Kimi", "Qwen Flash"]);
});

test("the agent must name the task and a profile, while the user's /race:race without them gets a form, filled in with what they said", async () => {
  await expect(fakeMirador().call(fakeMirador().captain, "race", {})).rejects.toThrow("Say what the racers should do: the task.");
  await expect(fakeMirador().call(fakeMirador().captain, "race", { task: "Make answer 42" })).rejects.toThrow("Name the profile the racers run on");
  const mirador = fakeMirador({ caller: "user" });

  const answer = await mirador.call(mirador.captain, "race", { check: "bun test" });

  expect(answer).toBe("Fill in the race on the canvas, then press Start race.");
  expect(mirador.started).toEqual([]);
  expect(mirador.raceItem().title).toBe("New race");
  expect(mirador.page()).toMatchObject({ phase: "setup", task: "", profiles: [], check: "bun test", size: 4, racers: [], startedByUser: true });
  expect(await mirador.act({ kind: "profiles" })).toEqual(PROFILES);
});

test("the form starts its race on its own page, waiting for the user's pick, and only once", async () => {
  const mirador = fakeMirador({ caller: "user" });
  await mirador.call(mirador.captain, "race", {});
  const formId = mirador.page().id;

  await expect(mirador.act({ kind: "start", task: " ", profiles: ["Kimi"] })).rejects.toThrow("Say what the racers should do");
  expect(await mirador.act({ kind: "start", task: "Make answer 42", profiles: ["Kimi", "Qwen Flash"], check: "true", decide: "captain" })).toEqual({ started: formId });

  expect(mirador.items).toHaveLength(1);
  expect(mirador.raceItem().title).toBe("Race · Make answer 42");
  expect(mirador.page()).toMatchObject({ id: formId, phase: "racing", startedByUser: true, size: 2, check: "true" });
  expect(mirador.started.map(({ profile, title }) => ({ profile, title }))).toEqual([
    { profile: "Kimi", title: `Race ${formId} · racer 1` },
    { profile: "Qwen Flash", title: `Race ${formId} · racer 2` },
  ]);
  await expect(mirador.act({ kind: "start", task: "Again", profile: "Kimi" })).rejects.toThrow("This race has started already.");
});

test("a race the user started waits for their pick: the captain hears the results and to wait, and the pick goes to it as their message", async () => {
  const mirador = fakeMirador({ caller: "user" });
  const answer = await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3 });
  expect(answer).toContain("When all have finished, you pick the work to take on the race page.");
  await expect(mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } })).rejects.toThrow("isn't waiting for a pick");
  for (const number of [1, 2]) await mirador.replied(number, finished(`Racer ${number} done.`));
  await mirador.replied(3, { text: null, ended: "failed" });

  const race = mirador.page();
  expect(race.phase).toBe("picking");
  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  expect(told?.text).toContain(`Race ${race.id} is over: 2 of 3 racers finished.`);
  expect(told?.text).toContain(`answer in one line that race ${race.id} is over and waits for their pick.`);
  expect(told?.text).not.toContain("Now decide");

  await expect(mirador.act({ kind: "pick", pick: { kind: "take", racer: 3 } })).rejects.toThrow("Pick among the racers that finished: 1, 2.");
  await expect(mirador.act({ kind: "pick", pick: { kind: "combine", racers: [2], how: "" } })).rejects.toThrow("Pick at least two racers to combine.");
  const { message } = (await mirador.act({ kind: "pick", pick: { kind: "take", racer: 2 } })) as { message: string };

  expect(message).toContain(`Take racer 2's work from race ${race.id} into your branch:`);
  expect(message).toContain(`branch ${mirador.started[1]!.branch} · folder ${mirador.started[1]!.folder}`);
  expect(message).toContain(`They started from ${race.base}.`);
  expect(mirador.page()).toMatchObject({ phase: "deciding", picked: "You took racer 2's work" });
  expect(mirador.promptsTo(mirador.captain.conversationId), "the page sends the pick, as the user's own message").toHaveLength(1);
  await expect(mirador.act({ kind: "pick", pick: { kind: "captain" } })).rejects.toThrow("isn't waiting for a pick");
});

test("combining racers asks the captain for the parts the user wants, and letting it pick hands it the decision", async () => {
  const mirador = fakeMirador({ caller: "user" });
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  const { message } = (await mirador.act({ kind: "pick", pick: { kind: "combine", racers: [1, 2], how: "Racer 1's parser, racer 2's tests" } })) as { message: string };

  expect(message).toContain(`Combine the work of racers 1, 2 from race ${mirador.page().id} in your branch:`);
  expect(message).toContain("How to combine them: Racer 1's parser, racer 2's tests");
  expect(mirador.page().picked).toBe("You asked to combine racers 1, 2");

  const other = fakeMirador({ caller: "user" });
  await other.call(other.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await other.replied(number, finished("done"));
  const { message: decide } = (await other.act({ kind: "pick", pick: { kind: "captain" } })) as { message: string };
  expect(decide).toContain("Now decide:");
});

test("two racers that each rank the other first make a tie, said as one, and each vote names what it ranked", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, decide: "vote" });
  for (const number of [1, 2]) await mirador.call(mirador.racer(number), "race_board", {});
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  await mirador.call(mirador.racer(1), "race_vote", { ranking: [2], why: "2's helper is cleaner" });
  await mirador.call(mirador.racer(2), "race_vote", { ranking: [1], why: "1 kept the API" });

  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  expect(told?.text).toContain("The racers voted: A tie: each ranked the other first.");
  expect(told?.text).toContain("- Racer 1 ranked 2 first: 2's helper is cleaner");
  expect(told?.text).toContain("- Racer 2 ranked 1 first: 1 kept the API");
});

test("voters hear what Race's check said in the others' folders, rather than run it", async () => {
  const mirador = fakeMirador({ caller: "user" });
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, decide: "vote", check: "exit 1" });
  for (const number of [1, 2]) await mirador.call(mirador.racer(number), "race_board", {});
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  const [asked] = mirador.promptsTo(mirador.started[0]!.id);
  expect(asked?.text).toMatch(/Race ran `exit 1` in each folder:\n- racer 2: failed with exit code 1 in [\d.]+ s/);
  expect(asked?.text).toContain("don't run long jobs: vote in this turn.");
});

test("a racer shows as checking while Race runs the check, and Stop race kills the check, which then tells nobody", async () => {
  const mirador = fakeMirador({ caller: "user" });
  const childPid = join(scratch, "child-pid");
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, check: `sleep 30 & echo $! > ${childPid}; wait` });

  const ending = mirador.replied(1, finished("done"));
  await until(() => mirador.page().racers[0]!.state === "checking", "racer 1 checking");
  await until(() => Bun.file(childPid).size > 0, "the check's child started");
  const sleeper = Number((await Bun.file(childPid).text()).trim());
  expect(await mirador.act({ kind: "stop" })).toEqual({ stopped: true });
  await ending;

  const race = mirador.page();
  expect(race.phase).toBe("stopped");
  expect(race.racers[0]).toMatchObject({ state: "finished", check: { outcome: "stopped", exitCode: null } });
  expect(mirador.stopped, "racer 2 still worked; racer 1's work had ended").toEqual([mirador.started[1]!.id]);
  await until(() => !isAlive(sleeper), "the check's child killed with it");
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a check that runs out of time is ended, with its group, and keeps only the end of what it printed", async () => {
  const slow = runCheck("echo started; sleep 30", scratch, { timeoutMs: 300 });
  expect(await slow.result).toMatchObject({ outcome: "timed out", exitCode: null, output: "started\n" });

  const loud = await runCheck("yes 0123456789 | head -c 50000; echo; echo the end", scratch, { outputLimit: 100 }).result;
  expect(loud.outcome).toBe("passed");
  expect(loud.output.length).toBeLessThanOrEqual(101);
  expect(loud.output.startsWith("…")).toBe(true);
  expect(loud.output.endsWith("the end\n")).toBe(true);
});

test("what a check leaves running stops when its shell exits, and one that won't stop still times out", async () => {
  const leftPid = join(scratch, "left-pid");
  const left = await runCheck(`sleep 30 & echo $! > ${leftPid}; echo started`, scratch, { timeoutMs: 10_000 }).result;
  expect(left).toMatchObject({ outcome: "passed", exitCode: 0, output: "started\n" });
  expect(left.durationMs).toBeLessThan(5_000);
  await until(() => !isAlive(Number(readFileSync(leftPid, "utf8").trim())), "the leftover sleep stopped with its check");

  const stubborn = await runCheck("(trap '' TERM; exec sleep 30) & echo started", scratch, { timeoutMs: 300, graceMs: 200 }).result;
  expect(stubborn).toMatchObject({ outcome: "timed out", exitCode: null, output: "started\n" });
  expect(stubborn.durationMs).toBeLessThan(5_000);
});

test("a check that can't start, as in a folder that's gone, fails with the reason, and the queue goes on", async () => {
  const queue = new CheckQueue(1);

  const [gone, next] = await Promise.all([queue.check("a", "true", join(scratch, "gone")), queue.check("a", "true", scratch)]);

  expect(gone).toMatchObject({ outcome: "failed", exitCode: null, output: expect.stringContaining("ENOENT") });
  expect(next.outcome).toBe("passed");
});

test("the check queue runs two at a time, and a race's stop drops its waiting checks and stops its running ones", async () => {
  const running = new Set<string>();
  let most = 0;
  const fakes = new Map<string, { finish: (result: CheckResult) => void; stopped: boolean }>();
  const queue = new CheckQueue(2, (command): RunningCheck => {
    const { promise, resolve } = Promise.withResolvers<CheckResult>();
    running.add(command);
    most = Math.max(most, running.size);
    const fake = { finish: (result: CheckResult) => (running.delete(command), resolve(result)), stopped: false };
    fakes.set(command, fake);
    return { result: promise, stop: () => ((fake.stopped = true), fake.finish({ outcome: "stopped", exitCode: null, durationMs: 1, output: "" })) };
  });
  const passed: CheckResult = { outcome: "passed", exitCode: 0, durationMs: 1, output: "" };

  const results = ["a1", "a2", "b1", "a3"].map((command) => queue.check(command[0]!, command, scratch));
  expect([...running]).toEqual(["a1", "a2"]);
  fakes.get("a1")!.finish(passed);
  await results[0];
  await until(() => running.has("b1"), "b1 started once a1 ended");
  queue.stopRace("a");

  expect(await results[3]).toMatchObject({ outcome: "stopped", durationMs: 0 });
  expect(fakes.has("a3"), "a3 never started").toBe(false);
  expect(fakes.get("a2")!.stopped).toBe(true);
  expect(fakes.get("b1")!.stopped).toBe(false);
  expect(most).toBe(2);
});

test("the page shows a racer's changes as a patch, as race_peek does", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  writeFileSync(join(mirador.started[1]!.folder, "app.ts"), "export const answer = 42;\n");

  const { diff } = (await mirador.act({ kind: "diff", racer: 2 })) as { diff: string };

  expect(diff).toContain("+export const answer = 42;");
  expect(await mirador.act({ kind: "diff", racer: 1 })).toEqual({ diff: "Racer 1 hasn't changed anything yet." });
});
