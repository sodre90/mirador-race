import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import host, { ITEM_TYPE } from "../host.ts";
import type { CanvasActionContext, CanvasPluginStorage, CanvasToolContext, ConversationReply, PluginActivity, PluginItem } from "../mirador/api.ts";
import { tally, type Race } from "../race.ts";

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

/** Mirador as the plugin sees it: one storage, the items of each conversation, and conversations started in real worktrees of the repo. */
function fakeMirador({ refuseRacer }: { refuseRacer?: number } = {}) {
  const kept = new Map<string, string>();
  const storage: CanvasPluginStorage = {
    get: (key) => (kept.has(key) ? JSON.parse(kept.get(key)!) : undefined),
    set: (key, value) => (value === undefined ? kept.delete(key) : kept.set(key, JSON.stringify(value))),
  };
  const items: (PluginItem<Race> & { conversationId: string })[] = [];
  const prompts: { conversationId: string; text: string; afterTurn: boolean }[] = [];
  const stopped: string[] = [];
  const started: { id: string; prompt: string; title?: string; folder: string; branch: string }[] = [];
  const contextOf = (conversationId: string): Context => ({
    conversationId,
    caller: "agent",
    storage,
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
    async startConversation({ prompt, title, worktree }) {
      if (worktree !== "own") throw new Error("The race asked for no worktree of its own.");
      if (refuseRacer === started.length + 1) throw new Error("A conversation gets its own worktree only in a git repository with a commit.");
      const id = crypto.randomUUID();
      const short = id.slice(0, 8);
      const folder = join(scratch, "worktrees", short);
      const branch = `mirador/${short}`;
      await git(repo, ["worktree", "add", "-q", "-b", branch, folder, "HEAD"]);
      started.push({ id, prompt, ...(title && { title }), folder, branch });
      return { id, profile: "Qwen Flash", worktree: { folder, branch } };
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
  const replied = (number: number, reply: ConversationReply) => host.replied!({ id: started[number - 1]!.id, profile: "Qwen Flash" }, reply, captain);
  const heard = (number: number, activity: PluginActivity) =>
    host.activity!({ ...activity, conversationId: started[number - 1]!.id, conversationTitle: "", at: Date.now() } as never, { storage, windowChanged() {}, profileSetting: () => null });
  const promptsTo = (conversationId: string) => prompts.filter((prompt) => prompt.conversationId === conversationId);
  return { captain, contextOf, call, page, racer, replied, heard, prompts, promptsTo, stopped, started, items };
}

const finished = (text: string): ConversationReply => ({ text, ended: "finished" });

test("a race starts its racers on one profile, each in a worktree of its own with its number, and shows them on a page", async () => {
  const mirador = fakeMirador();

  const answer = await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "qwen flash", racers: 3, check: "bun test" });

  expect(mirador.started).toHaveLength(3);
  expect(new Set(mirador.started.map(({ folder }) => folder)).size).toBe(3);
  expect(mirador.started[1]!.prompt).toContain("You are racer 2 of 3");
  expect(mirador.started[1]!.prompt).toContain("Make answer 42");
  expect(mirador.started[1]!.prompt).toContain("run `bun test` in your folder");
  expect(mirador.started[0]!.title).toMatch(/^Race [0-9a-f]{6} · racer 1$/);
  const race = mirador.page();
  expect(race).toMatchObject({ task: "Make answer 42", profile: "Qwen Flash", size: 3, phase: "racing", decide: "captain", check: "bun test" });
  expect(race.racers.map(({ number, branch, state }) => ({ number, branch, state }))).toEqual(mirador.started.map(({ branch }, index) => ({ number: index + 1, branch, state: "starting" })));
  expect(answer).toContain(`Race ${race.id} started: 3 racers on Qwen Flash`);
  expect(answer).toContain(mirador.started[2]!.branch);
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

test("once every racer's work ended, the captain hears each one's branch, folder, changes and words, and how to pick and merge", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3, check: "bun test" });
  writeFileSync(join(mirador.started[0]!.folder, "app.ts"), "export const answer = 42;\n");

  await mirador.replied(1, finished("Changed app.ts; bun test passes."));
  await mirador.replied(2, { text: null, ended: "failed" });
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
  await mirador.replied(3, finished("Done."));

  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  const race = mirador.page();
  expect(told?.afterTurn).toBe(true);
  expect(told?.text).toContain(`Race ${race.id} is over: 2 of 3 racers finished.`);
  expect(told?.text).toContain(`- Racer 1: finished · branch ${mirador.started[0]!.branch} · folder ${mirador.started[0]!.folder} · 1 file, +1 −1`);
  expect(told?.text).toContain("It said: Changed app.ts; bun test passes.");
  expect(told?.text).toContain("- Racer 2: failed");
  expect(told?.text).toContain("Run `bun test` in each finished racer's folder.");
  expect(told?.text).toContain(race.base!);
  expect(race.phase).toBe("deciding");
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
    { racer: 3, points: 2 },
    { racer: 1, points: 1 },
    { racer: 2, points: 0 },
  ]);
  expect(told?.text).toContain("The racers voted: racer 3 2 points, racer 1 1 point, racer 2 0 points.");
  expect(told?.text).toContain("- Racer 1: 3 has a test");
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
    { racer: 2, points: 2 },
    { racer: 3, points: 1 },
    { racer: 1, points: 0 },
  ]);
});
