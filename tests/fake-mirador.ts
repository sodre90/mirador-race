import { join } from "node:path";
import host, { ITEM_TYPE } from "../host.ts";
import type { CanvasActionContext, CanvasPluginStorage, CanvasToolContext, ConversationReply, PluginActivity, PluginItem } from "../mirador/api.ts";
import type { BenchRun } from "../bench.ts";
import type { Race } from "../race.ts";

export async function git(folder: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout;
}

export const until = async (condition: () => boolean, what: string) => {
  for (let tries = 0; tries < 400 && !condition(); tries++) await Bun.sleep(10);
  if (!condition()) throw new Error(`Never came: ${what}`);
};

export const finished = (text: string): ConversationReply => ({ text, ended: "finished" });

export const PROFILES = [
  { name: "Qwen Flash", agent: "opencode", model: null, effort: null },
  { name: "Kimi", agent: "claude", model: { id: "opus", name: "Kimi K3" }, effort: "high" },
];

type Context<Data> = CanvasToolContext<Data> & CanvasActionContext<Data>;

/** Mirador as the plugin sees it: one storage, the items of each conversation, and conversations started in real worktrees of the repo. */
export function fakeMirador<Data extends Race | BenchRun = Race>({
  repo,
  scratch,
  refuseRacer,
  refuseProfile,
  caller = "user",
  itemType = ITEM_TYPE,
}: {
  repo: string;
  scratch: string;
  refuseRacer?: number;
  refuseProfile?: string;
  caller?: "agent" | "user";
  itemType?: string;
}) {
  const kept = new Map<string, string>();
  const storage: CanvasPluginStorage = {
    get: (key) => (kept.has(key) ? JSON.parse(kept.get(key)!) : undefined),
    set: (key, value) => (value === undefined ? kept.delete(key) : kept.set(key, JSON.stringify(value))),
  };
  const items: (PluginItem<Data> & { conversationId: string })[] = [];
  const prompts: { conversationId: string; text: string; afterTurn: boolean }[] = [];
  const stopped: string[] = [];
  const started: { id: string; profile: string; prompt: string; title?: string; folder: string; branch: string; model?: string; effort?: string; from?: string }[] = [];
  /** Conversations started beside the captain, with no worktree, such as a race's judge. */
  const beside: { id: string; profile: string; prompt: string; title?: string }[] = [];
  const contextOf = (conversationId: string): Context<Data> => ({
    conversationId,
    caller,
    workspace: { id: "w1", name: "set", folder: repo },
    storage,
    profiles: () => PROFILES,
    usageOf: () => ({ inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedWriteTokens: 5, cost: { amount: 0.25, currency: "USD" }, turns: 1 }),
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
    async startConversation({ profile: asked, prompt, title, model, effort, worktree }) {
      const profile = PROFILES.find(({ name }) => name.toLowerCase() === asked.toLowerCase())?.name;
      if (!profile) throw new Error(`There is no profile named ${asked}.`);
      if (refuseRacer === started.length + beside.length + 1) throw new Error("A conversation gets its own worktree only in a git repository with a commit.");
      if (refuseProfile === profile) throw new Error(`The profile ${profile} can't start a conversation now.`);
      const id = crypto.randomUUID();
      if (!worktree) {
        beside.push({ id, profile, prompt, title });
        return { id, profile };
      }
      const short = id.slice(0, 8);
      const folder = join(scratch, "worktrees", short);
      const branch = `mirador/${short}`;
      const from = worktree === "own" ? "HEAD" : worktree.from;
      await git(repo, ["worktree", "add", "-q", "-b", branch, folder, from]);
      started.push({ id, profile, prompt, ...(title && { title }), folder, branch, ...(model && { model }), ...(effort && { effort }), ...(worktree !== "own" && { from }) });
      return { id, profile, worktree: { folder, branch } };
    },
    async stopConversation(id) {
      stopped.push(id);
    },
    async promptStarted(id, text) {
      prompts.push({ conversationId: id, text, afterTurn: true });
    },
    openInEditor() {},
  });
  const captain = contextOf(crypto.randomUUID());
  const call = async (context: Context<Data>, tool: string, input: Record<string, unknown>) => host.tools[tool]!.run(input, context);
  const page = () => items.find((item) => item.type === itemType && item.conversationId === captain.conversationId)!.data;
  const racer = (number: number) => contextOf(started[number - 1]!.id);
  const replied = (number: number, reply: ConversationReply) => host.replied!({ id: started[number - 1]!.id, profile: started[number - 1]!.profile }, reply, captain);
  const judgeReplied = (reply: ConversationReply) => host.replied!({ id: beside.at(-1)!.id, profile: beside.at(-1)!.profile }, reply, captain);
  const raceItem = () => items.find((item) => item.type === itemType && item.conversationId === captain.conversationId)!;
  const act = (action: Record<string, unknown>) => host.action!(raceItem(), action, captain);
  const heard = (number: number, activity: PluginActivity) =>
    host.activity!({ ...activity, conversationId: started[number - 1]!.id, conversationTitle: "", at: Date.now() } as never, { storage, windowChanged() {}, profileSetting: () => null, profiles: () => PROFILES, settingOfProfile: () => null });
  const promptsTo = (conversationId: string) => prompts.filter((prompt) => prompt.conversationId === conversationId);
  return { captain, contextOf, call, page, racer, replied, judgeReplied, heard, prompts, promptsTo, stopped, started, beside, items, raceItem, act };
}