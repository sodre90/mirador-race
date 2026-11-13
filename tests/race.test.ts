import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import host, { ITEM_TYPE } from "../host.ts";
import { runCheck, CheckQueue, endLeftover, type RunningCheck } from "../check.ts";
import { copyCheckFilesOver } from "../check-files.ts";
import { raceRequest, tally, type CheckResult, type Race, type Racer } from "../race.ts";
import { fakeMirador as fakeMiradorIn, finished, git, PROFILES, until } from "./fake-mirador.ts";

let scratch: string;
let repo: string;

const fakeMirador = (options: { refuseRacer?: number; caller?: "agent" | "user" } = {}) => fakeMiradorIn({ ...options, repo, scratch });

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

test("a race starts its racers on one profile, each in a worktree of its own with its number, and shows them on a page", async () => {
  const mirador = fakeMirador();

  const answer = await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "qwen flash", racers: 3, check: "bun test" });
  expect(mirador.started.map(({ profile }) => profile)).toEqual(["Qwen Flash", "Qwen Flash", "Qwen Flash"]);

  expect(mirador.started).toHaveLength(3);
  expect(new Set(mirador.started.map(({ folder }) => folder)).size).toBe(3);
  expect(mirador.started[1]!.prompt).toContain("You are racer 2 of 3");
  expect(mirador.started[1]!.prompt).toContain("Make answer 42");
  expect(mirador.started[1]!.prompt).toContain("run `bun test` in your folder and make it pass; Race runs it there too once you finish.\n");
  expect(mirador.started[0]!.title).toMatch(/^Race [0-9a-f]{6} · racer 1$/);
  const race = mirador.page();
  expect(race).toMatchObject({ task: "Make answer 42", profiles: ["qwen flash"], size: 3, phase: "racing", decide: "captain", check: "bun test" });
  expect(race.racers.map(({ number, branch, state, profile }) => ({ number, branch, state, profile }))).toEqual(
    mirador.started.map(({ branch }, index) => ({ number: index + 1, branch, state: "starting", profile: "Qwen Flash" })),
  );
  expect(answer).toContain(`Race ${race.id} started: 3 racers, each in a worktree of its own (racer 1 on Qwen Flash, branch ${mirador.started[0]!.branch};`);
  expect(answer).toContain("When all have finished, you pick the work to take on the race page.");
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

test("once every racer's work ended, the captain hears each one's branch, folder, changes and words, and to wait for the user's pick", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3 });
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
  expect(told?.text).toContain(race.base!);
  expect(told?.text).toContain(`answer in one line that race ${race.id} is over and waits for their pick.`);
  expect(race.phase).toBe("picking");
  expect(race.racers.map(({ check, state }) => ({ check, state }))).toEqual([
    { check: null, state: "finished" },
    { check: null, state: "failed" },
    { check: null, state: "finished" },
  ]);
  expect(race.racers.map(({ endedAt }) => endedAt !== null)).toEqual([true, true, true]);
});

test("Race runs the race's check in each racer's folder once it finished, and the captain hears what it said with the results", async () => {
  const mirador = fakeMirador();
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
  expect(mirador.page().phase).toBe("picking");
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

test("a vote no racer can be asked for goes straight to the user's pick", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, decide: "vote" });

  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  expect(mirador.page().phase).toBe("picking");
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

test("racers can run on a profile each, which repeat in turn when there are more racers", async () => {
  const mirador = fakeMirador();

  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profiles: ["qwen flash", "kimi"], racers: 3 });

  expect(mirador.started.map(({ profile }) => profile)).toEqual(["Qwen Flash", "Kimi", "Qwen Flash"]);
  expect(mirador.page().racers.map(({ profile }) => profile)).toEqual(["Qwen Flash", "Kimi", "Qwen Flash"]);
  await mirador.call(mirador.captain, "race", { task: "Compare them", profiles: ["Kimi", "Qwen Flash"] });
  expect(mirador.started.slice(3).map(({ profile }) => profile), "one racer per profile when several are named").toEqual(["Kimi", "Qwen Flash"]);
});

test("the agent's race only drafts its form, filled in with what it asked, and nothing runs until the user presses Start race", async () => {
  const mirador = fakeMirador({ caller: "agent" });

  const answer = await mirador.call(mirador.captain, "race", { task: "Make answer 42", profiles: ["kimi", "Qwen Flash"], check: "true", decide: "vote" });

  expect(answer).toContain("Nothing runs until the user checks it and presses Start race");
  expect(mirador.started).toEqual([]);
  expect(mirador.raceItem().title).toBe("New race");
  expect(mirador.page()).toMatchObject({ phase: "setup", task: "Make answer 42", profiles: ["kimi", "Qwen Flash"], size: 2, check: "true", decide: "vote", racers: [] });

  expect(await mirador.act({ kind: "start", task: "Make answer 42", profiles: ["Kimi", "Qwen Flash"], check: "true", decide: "vote" })).toEqual({ started: mirador.page().id });
  expect(mirador.started.map(({ profile }) => profile)).toEqual(["Kimi", "Qwen Flash"]);
  expect(mirador.page()).toMatchObject({ phase: "racing", check: "true", decide: "vote" });
});

test("the agent's draft needs the task, and names only profiles Mirador has, or none for the user to choose", async () => {
  const mirador = fakeMirador({ caller: "agent" });

  await expect(mirador.call(mirador.captain, "race", { profile: "Kimi" })).rejects.toThrow("Say what the racers should do: the task.");
  await expect(mirador.call(mirador.captain, "race", { task: "Make answer 42", profiles: ["Kimi", "Opus"] })).rejects.toThrow(
    "There is no profile named Opus. The profiles are: Qwen Flash, Kimi; or leave profiles out for the user to choose.",
  );
  expect(mirador.items).toEqual([]);

  await mirador.call(mirador.captain, "race", { task: "Make answer 42" });
  expect(mirador.page()).toMatchObject({ phase: "setup", task: "Make answer 42", profiles: [], size: 4 });
  expect(mirador.started).toEqual([]);
});

test("an agent's draft carries its advice to the form, and a race the user starts from /race:race has none", async () => {
  const agent = fakeMirador({ caller: "agent" });
  await agent.call(agent.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", advice: " Hidden tests fit: parse has clear right answers. " });
  expect(agent.page()).toMatchObject({ phase: "setup", advice: "Hidden tests fit: parse has clear right answers." });

  const blank = fakeMirador({ caller: "agent" });
  await blank.call(blank.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", advice: "   " });
  expect(blank.page().advice).toBeNull();

  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", {});
  expect(mirador.page().advice).toBeNull();
  await mirador.act({ kind: "start", task: "Make answer 42", profiles: ["Qwen Flash", "Kimi"] });
  expect(mirador.page().advice, "a started race keeps no advice: only the form shows it").toBeNull();
});

test("the race tool's guidance and description tell the agent to advise how to check the work", () => {
  const description = host.tools.race!.description;
  expect(description).toContain("Advise how to check the work");
  expect(description).toContain("checkFiles");
  expect(description).toContain("judge");
  expect(description).toContain("advice");
  expect(host.guidance!.instructions).toContain("Advise how to check their work");
});

test("the user's /race:race without a task or a profile gets a form, filled in with what they said", async () => {
  const mirador = fakeMirador();

  const answer = await mirador.call(mirador.captain, "race", { check: "bun test" });

  expect(answer).toBe("Fill in the race on the canvas, then press Start race.");
  expect(mirador.started).toEqual([]);
  expect(mirador.raceItem().title).toBe("New race");
  expect(mirador.page()).toMatchObject({ phase: "setup", task: "", profiles: [], check: "bun test", size: 4, racers: [] });
  expect(await mirador.act({ kind: "profiles" })).toEqual(PROFILES);
});

test("the form starts its race on its own page, waiting for the user's pick, and only once", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", {});
  const formId = mirador.page().id;

  await expect(mirador.act({ kind: "start", task: " ", profiles: ["Kimi"] })).rejects.toThrow("Say what the racers should do");
  expect(await mirador.act({ kind: "start", task: "Make answer 42", profiles: ["Kimi", "Qwen Flash"], check: "true", decide: "captain" })).toEqual({ started: formId });

  expect(mirador.items).toHaveLength(1);
  expect(mirador.raceItem().title).toBe("Race · Make answer 42");
  expect(mirador.page()).toMatchObject({ id: formId, phase: "racing", size: 2, check: "true" });
  expect(mirador.started.map(({ profile, title }) => ({ profile, title }))).toEqual([
    { profile: "Kimi", title: `Race ${formId} · racer 1` },
    { profile: "Qwen Flash", title: `Race ${formId} · racer 2` },
  ]);
  await expect(mirador.act({ kind: "start", task: "Again", profile: "Kimi" })).rejects.toThrow("This race has started already.");
});

test("a race the user started waits for their pick: the captain hears the results and to wait, and the pick goes to it as their message", async () => {
  const mirador = fakeMirador();
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
  expect(mirador.page().phase, "the pick holds until its message went").toBe("picking");
  expect(await mirador.act({ kind: "picked", pick: { kind: "take", racer: 2 } })).toEqual({ picked: true });
  expect(mirador.page()).toMatchObject({ phase: "deciding", picked: "You took racer 2's work" });
  expect(mirador.promptsTo(mirador.captain.conversationId), "the page sends the pick, as the user's own message").toHaveLength(1);
  await expect(mirador.act({ kind: "pick", pick: { kind: "captain" } })).rejects.toThrow("isn't waiting for a pick");
  await expect(mirador.act({ kind: "picked", pick: { kind: "captain" } })).rejects.toThrow("isn't waiting for a pick");
});

test("a pick whose message never went leaves the race waiting for the user's pick", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  await mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } });

  expect(mirador.page()).toMatchObject({ phase: "picking", picked: null });
  const { message } = (await mirador.act({ kind: "pick", pick: { kind: "take", racer: 2 } })) as { message: string };
  expect(message).toContain("Take racer 2's work");
});

test("combining racers asks the captain for the parts the user wants, and letting it pick hands it the decision", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  const { message } = (await mirador.act({ kind: "pick", pick: { kind: "combine", racers: [1, 2], how: "Racer 1's parser, racer 2's tests" } })) as { message: string };

  expect(message).toContain(`Combine the work of racers 1, 2 from race ${mirador.page().id} in your branch:`);
  expect(message).toContain("How to combine them: Racer 1's parser, racer 2's tests");
  await mirador.act({ kind: "picked", pick: { kind: "combine", racers: [1, 2], how: "Racer 1's parser, racer 2's tests" } });
  expect(mirador.page().picked).toBe("You asked to combine racers 1, 2");

  const other = fakeMirador();
  await other.call(other.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await other.replied(number, finished("done"));
  const { message: decide } = (await other.act({ kind: "pick", pick: { kind: "captain" } })) as { message: string };
  expect(decide).toContain("Now decide:");
});

test("deleteRacers is refused while the race is racing or picking, and deletes nothing", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  const refusal = "Delete the racers once the captain has taken their work.";

  await expect(mirador.act({ kind: "deleteRacers" })).rejects.toThrow(refusal);
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));
  expect(mirador.page().phase).toBe("picking");
  await expect(mirador.act({ kind: "deleteRacers" })).rejects.toThrow(refusal);

  expect(mirador.deleted).toEqual([]);
  expect(mirador.page().racers.map(({ deletedAt }) => deletedAt)).toEqual([null, null]);
});

test("after the pick, deleteRacers waits for the captain's turn to end, and a later turn starting holds it again", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));
  const refusal = "Delete the racers once the captain has taken their work.";

  await mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } });
  await mirador.captainHeard({ kind: "turn-started" });
  await mirador.act({ kind: "picked", pick: { kind: "take", racer: 1 } });
  await expect(mirador.act({ kind: "deleteRacers" })).rejects.toThrow(refusal);

  await mirador.captainHeard({ kind: "turn-ended", ended: "finished" });
  expect(typeof mirador.page().workTakenAt).toBe("number");

  await mirador.captainHeard({ kind: "turn-started" });
  expect(mirador.page().workTakenAt).toBeNull();
  await expect(mirador.act({ kind: "deleteRacers" })).rejects.toThrow(refusal);

  await mirador.captainHeard({ kind: "turn-ended", ended: "finished" });
  expect(await mirador.act({ kind: "deleteRacers" })).toEqual({ deleted: 2 });
});

test("a captain's turn that ended before the pick doesn't count as taking the work", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  await mirador.captainHeard({ kind: "turn-ended", ended: "finished" });
  await mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } });
  await mirador.act({ kind: "picked", pick: { kind: "take", racer: 1 } });

  expect(mirador.page().workTakenAt).toBeNull();
  await expect(mirador.act({ kind: "deleteRacers" })).rejects.toThrow("Delete the racers once the captain has taken their work.");
});

test("a pick asked again, after a captain turn ended since the first ask, waits for the captain anew", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  await mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } });
  await mirador.captainHeard({ kind: "turn-ended", ended: "finished" });
  expect(typeof mirador.page().workTakenAt, "the turn ended after the first ask, whose message never went").toBe("number");
  await mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } });
  await mirador.act({ kind: "picked", pick: { kind: "take", racer: 1 } });

  expect(mirador.page().workTakenAt).toBeNull();
  await expect(mirador.act({ kind: "deleteRacers" })).rejects.toThrow("Delete the racers once the captain has taken their work.");
});

test("a race stored without the new fields, as Race 0.4.0 left it, shows no racer deleted and refuses deleteRacers in deciding", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));
  await mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } });
  await mirador.act({ kind: "picked", pick: { kind: "take", racer: 1 } });
  const id = mirador.page().id;
  const kept = mirador.captain.storage.get(`race:${id}`) as { race: Race };
  const stored = kept.race as Partial<Race>;
  delete stored.pickAskedAt;
  delete stored.workTakenAt;
  for (const racer of kept.race.racers) {
    delete (racer as Partial<Racer>).patch;
    delete (racer as Partial<Racer>).deletedAt;
  }
  mirador.captain.storage.set(`race:${id}`, kept);

  expect(await mirador.act({ kind: "diff", racer: 1 })).toEqual({ diff: "Racer 1 hasn't changed anything yet." });
  expect(mirador.page().racers.every((racer) => typeof racer.deletedAt !== "number")).toBe(true);
  await mirador.captainHeard({ kind: "turn-ended", ended: "finished" });
  expect(mirador.page().workTakenAt).toBeUndefined();
  await expect(mirador.act({ kind: "deleteRacers" })).rejects.toThrow("Delete the racers once the captain has taken their work.");
  expect(mirador.deleted).toEqual([]);
});

test("once the work is taken, deleteRacers deletes every racer, keeping each one's changes on the page, and the judge stays", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, judge: "Kimi" });
  writeFileSync(join(mirador.started[0]!.folder, "app.ts"), "export const answer = 42;\n");
  writeFileSync(join(mirador.started[1]!.folder, "notes.md"), "the answer is 42\n");
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));
  await mirador.judgeReplied(finished("I read them all."));
  await mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } });
  await mirador.act({ kind: "picked", pick: { kind: "take", racer: 1 } });
  await mirador.captainHeard({ kind: "turn-ended", ended: "finished" });

  const first = mirador.act({ kind: "deleteRacers" });
  await expect(mirador.act({ kind: "deleteRacers" })).rejects.toThrow("The racers are being deleted already.");
  expect(await first).toEqual({ deleted: 2 });

  expect(mirador.deleted).toEqual(mirador.started.map(({ id }) => id));
  const race = mirador.page();
  expect(race.racers[0]!.patch).toContain("+export const answer = 42;");
  expect(race.racers[1]!.patch).toContain("+the answer is 42");
  expect(race.racers.map(({ changes }) => changes)).toEqual(["1 file, +1 −1", "1 file, +1 −0"]);
  for (const racer of race.racers) expect(typeof racer.deletedAt).toBe("number");
  for (const { id } of mirador.started) expect(mirador.captain.storage.get(`racer:${id}`)).toBeUndefined();
  expect(mirador.captain.storage.get(`judge:${mirador.beside[0]!.id}`)).toEqual({ race: race.id });
  expect(await mirador.act({ kind: "diff", racer: 1 })).toEqual({ diff: race.racers[0]!.patch });
  expect(await mirador.act({ kind: "diff", racer: 2 })).toEqual({ diff: race.racers[1]!.patch });
  expect(await mirador.act({ kind: "deleteRacers" })).toEqual({ deleted: 0 });
});

test("a stopped race can delete its racers too", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  writeFileSync(join(mirador.started[0]!.folder, "app.ts"), "export const answer = 42;\n");
  await mirador.act({ kind: "diff", racer: 1 });
  await mirador.act({ kind: "stop" });

  expect(await mirador.act({ kind: "deleteRacers" })).toEqual({ deleted: 2 });

  expect(mirador.deleted).toEqual(mirador.started.map(({ id }) => id));
  expect(mirador.page().racers[0]!.patch).toContain("+export const answer = 42;");
  expect(mirador.page().racers[1]!.patch).toBe("");
});

test("a racer that changed nothing gets an empty patch, and its diff says it didn't change anything", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));
  await mirador.act({ kind: "pick", pick: { kind: "captain" } });
  await mirador.act({ kind: "picked", pick: { kind: "captain" } });
  await mirador.captainHeard({ kind: "turn-ended", ended: "finished" });

  expect(await mirador.act({ kind: "deleteRacers" })).toEqual({ deleted: 2 });

  expect(mirador.page().racers.map(({ patch }) => patch)).toEqual(["", ""]);
  expect(await mirador.act({ kind: "diff", racer: 1 })).toEqual({ diff: "Racer 1 didn't change anything." });
});

test("a racer whose folder is gone when it's deleted keeps no patch, and its diff says so", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));
  await mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } });
  await mirador.act({ kind: "picked", pick: { kind: "take", racer: 1 } });
  await mirador.captainHeard({ kind: "turn-ended", ended: "finished" });
  await rm(mirador.started[0]!.folder, { recursive: true, force: true });

  expect(await mirador.act({ kind: "deleteRacers" })).toEqual({ deleted: 2 });

  expect(mirador.page().racers[0]!.patch).toBeNull();
  expect(await mirador.act({ kind: "diff", racer: 1 })).toEqual({ diff: "Racer 1's changes couldn't be kept when it was deleted." });
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
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, decide: "vote", check: "exit 1" });
  for (const number of [1, 2]) await mirador.call(mirador.racer(number), "race_board", {});
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  const [asked] = mirador.promptsTo(mirador.started[0]!.id);
  expect(asked?.text).toMatch(/Race ran `exit 1` in each folder:\n- racer 2: failed with exit code 1 in [\d.]+ s/);
  expect(asked?.text).toContain("don't run long jobs: vote in this turn.");
});

test("a race with a judge starts it beside the captain once every racer is checked, with the task and each finished racer's work in its prompt, and the captain hears nothing until it scores", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, check: "true", judge: "kimi" });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  const race = mirador.page();
  expect(race.phase).toBe("judging");
  expect(race.judge).toBe("Kimi");
  expect(mirador.beside).toHaveLength(1);
  expect(mirador.beside[0]!.profile).toBe("Kimi");
  expect(mirador.beside[0]!.title).toBe(`Race ${race.id} · judge`);
  expect(mirador.beside[0]!.prompt).toContain(`You judge race ${race.id}: 2 agents worked on the task below at once`);
  expect(mirador.beside[0]!.prompt).toContain("Make answer 42");
  expect(mirador.beside[0]!.prompt).toContain(`branch ${mirador.started[0]!.branch}`);
  expect(mirador.beside[0]!.prompt).toContain(`branch ${mirador.started[1]!.branch}`);
  expect(mirador.beside[0]!.prompt).toContain("race_peek (racers 1, 2)");
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);

  const judge = mirador.contextOf(mirador.beside[0]!.id);
  expect(await mirador.call(judge, "race_peek", { racer: 1 })).toBe("Racer 1 hasn't changed anything yet.");
  await expect(mirador.call(judge, "race_board", {})).rejects.toThrow("The judge reads the racers' work with race_peek and scores it with race_judge; the board is the racers'.");
  await expect(mirador.call(judge, "race_vote", { ranking: [2], why: "2" })).rejects.toThrow("Only a race's racers vote.");
});

test("the judge's scores are in the captain's message, best first, and the race waits for the pick", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, judge: "Kimi" });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  const judge = mirador.contextOf(mirador.beside[0]!.id);
  const answer = await mirador.call(judge, "race_judge", {
    scores: [
      { racer: 1, score: 5, why: "half the task" },
      { racer: 2, score: 8, why: "the whole task, clean" },
    ],
    summary: "Racer 2 did it all.",
  });

  expect(answer).toBe("Your scores are in. End your turn.");
  expect(mirador.page().phase).toBe("picking");
  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  expect(told?.afterTurn).toBe(true);
  expect(told?.text).toContain("The judge (Kimi) scored their work against the task:\n- Racer 2: 8/10. the whole task, clean\n- Racer 1: 5/10. half the task\nRacer 2 did it all.");
  await expect(mirador.call(judge, "race_judge", { scores: [{ racer: 1, score: 5, why: "again" }, { racer: 2, score: 8, why: "again" }] })).rejects.toThrow(`Race ${mirador.page().id} isn't waiting for scores.`);
});

test("race_judge refuses scores that miss a finished racer, score one twice, or go outside 0 to 10, and anyone but the judge", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 3, judge: "Kimi" });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));
  await mirador.replied(3, { text: null, ended: "failed" });

  const judge = mirador.contextOf(mirador.beside[0]!.id);
  const refusal = "Score each racer that finished exactly once, from 0 to 10: 1, 2.";
  const score = (racer: number, points: number) => ({ racer, score: points, why: "why" });
  await expect(mirador.call(judge, "race_judge", { scores: [score(1, 5)] })).rejects.toThrow(refusal);
  await expect(mirador.call(judge, "race_judge", { scores: [score(1, 5), score(1, 6)] })).rejects.toThrow(refusal);
  await expect(mirador.call(judge, "race_judge", { scores: [score(1, 5), score(3, 6)] })).rejects.toThrow(refusal);
  await expect(mirador.call(judge, "race_judge", { scores: [score(1, 11), score(2, 5)] })).rejects.toThrow(refusal);
  await expect(mirador.call(judge, "race_judge", { scores: [score(1, -1), score(2, 5)] })).rejects.toThrow(refusal);
  await expect(mirador.call(judge, "race_judge", { scores: [score(1, 5.5), score(2, 5)] })).rejects.toThrow(refusal);
  await expect(mirador.call(mirador.captain, "race_judge", { scores: [score(1, 5), score(2, 5)] })).rejects.toThrow("Only a race's judge scores the racers' work.");
  await expect(mirador.call(mirador.racer(1), "race_judge", { scores: [score(1, 5), score(2, 5)] })).rejects.toThrow("Only a race's judge scores the racers' work.");
  expect(mirador.page().phase).toBe("judging");
});

test("with a vote and a judge, the judge starts once the vote is over", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, decide: "vote", judge: "Kimi" });
  for (const number of [1, 2]) await mirador.call(mirador.racer(number), "race_board", {});
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));
  expect(mirador.page().phase).toBe("voting");
  expect(mirador.beside).toEqual([]);

  await mirador.call(mirador.racer(1), "race_vote", { ranking: [2], why: "2" });
  expect(mirador.beside).toEqual([]);
  await mirador.call(mirador.racer(2), "race_vote", { ranking: [1], why: "1" });

  expect(mirador.page().phase).toBe("judging");
  expect(mirador.page().standings, "the page shows the vote's standings while the judge works").toHaveLength(2);
  expect(mirador.beside).toHaveLength(1);
  expect(mirador.promptsTo(mirador.captain.conversationId)).toEqual([]);
});

test("a judge that ends its turn without scoring, or can't start, lets the race go on to the pick, and the captain hears why", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, judge: "Kimi" });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  await mirador.judgeReplied(finished("I read them all."));

  expect(mirador.page().phase).toBe("picking");
  expect(mirador.page().judging).toMatchObject({ profile: "Kimi", scores: [], missed: "it ended its turn without scoring" });
  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  expect(told?.text).toContain("The judge (Kimi) gave no scores: it ended its turn without scoring.");
  await mirador.judgeReplied({ text: null, ended: "stopped" });
  expect(mirador.promptsTo(mirador.captain.conversationId), "a judge's reply after the race moved on is ignored").toHaveLength(1);

  const refused = fakeMirador({ refuseRacer: 3 });
  await refused.call(refused.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, judge: "Kimi" });
  for (const number of [1, 2]) await refused.replied(number, finished("done"));

  expect(refused.page().phase).toBe("picking");
  expect(refused.page().judging!.missed).toContain("it couldn't start:");
  expect(refused.promptsTo(refused.captain.conversationId)[0]?.text).toContain("The judge (Kimi) gave no scores: it couldn't start:");
});

test("Stop race while the judge works stops only the judge, and the race goes on to the pick", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, judge: "Kimi" });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));
  expect(mirador.page().phase).toBe("judging");

  expect(await mirador.act({ kind: "stop" })).toEqual({ stopped: true });
  expect(mirador.stopped).toEqual([mirador.beside[0]!.id]);
  expect(mirador.page().phase, "the stop changes nothing else; the judge's reply moves the race on").toBe("judging");

  await mirador.judgeReplied({ text: null, ended: "stopped" });

  expect(mirador.page().phase).toBe("picking");
  expect(mirador.page().judging!.missed).toBe("it was stopped");
  expect(mirador.promptsTo(mirador.captain.conversationId)[0]?.text).toContain("The judge (Kimi) gave no scores: it was stopped.");
});

test("a race no racer finished has no judge to start", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, judge: "Kimi" });
  for (const number of [1, 2]) await mirador.replied(number, { text: null, ended: "failed" });

  expect(mirador.page().phase).toBe("picking");
  expect(mirador.page().judging).toBeNull();
  expect(mirador.beside).toEqual([]);
  expect(mirador.promptsTo(mirador.captain.conversationId)[0]?.text).toContain("no racer finished its work");
});

test("a draft or a start naming a judge Mirador has no profile for is refused", async () => {
  const refusal = "There is no profile named Opus for the judge.";

  const agent = fakeMirador({ caller: "agent" });
  await expect(agent.call(agent.captain, "race", { task: "t", profile: "Qwen Flash", judge: "Opus" })).rejects.toThrow(refusal);
  expect(agent.items).toEqual([]);
  await agent.call(agent.captain, "race", { task: "t", profile: "Qwen Flash", judge: "kimi" });
  expect(agent.page()).toMatchObject({ phase: "setup", judge: "kimi" });

  const mirador = fakeMirador();
  await expect(mirador.call(mirador.captain, "race", { task: "t", profile: "Qwen Flash", judge: "Opus" })).rejects.toThrow(refusal);
  await mirador.call(mirador.captain, "race", {});
  await expect(mirador.act({ kind: "start", task: "t", profiles: ["Qwen Flash", "Kimi"], judge: "Opus" })).rejects.toThrow(refusal);
  expect(await mirador.act({ kind: "start", task: "t", profiles: ["Qwen Flash", "Kimi"], judge: "kimi" })).toEqual({ started: mirador.page().id });
  expect(mirador.page().judge).toBe("Kimi");
});

test("a racer shows as checking while Race runs the check, and Stop race kills the check, which then tells nobody", async () => {
  const mirador = fakeMirador();
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
    return { pid: null, result: promise, stop: () => ((fake.stopped = true), fake.finish({ outcome: "stopped", exitCode: null, durationMs: 1, output: "" })) };
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
  expect(await queue.check("a", "a4", scratch), "a stopped race's later check").toMatchObject({ outcome: "stopped", durationMs: 0 });
  expect(fakes.has("a4")).toBe(false);
});

const leftoverCheck = () => {
  const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return { pid: child.pid, startedAt: Date.now() };
};

test("a check left running by a restart is ended, with its group, but not a process that took its pid since", async () => {
  const other = leftoverCheck();
  await endLeftover({ pid: other.pid, startedAt: other.startedAt - 60_000 });
  expect(isAlive(other.pid), "started a minute after the check did, so not the check").toBe(true);
  process.kill(other.pid, "SIGKILL");

  const leftover = leftoverCheck();
  await endLeftover(leftover);
  await until(() => !isAlive(leftover.pid), "the leftover check ended");
});

test("a racer whose check a restart cut short is checked again once its race's page shows, after what's left of the old check ends", async () => {
  const mirador = fakeMirador();
  const runs = join(scratch, "runs");
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, check: `echo ran >> ${runs}; grep 42 app.ts` });
  writeFileSync(join(mirador.started[1]!.folder, "app.ts"), "export const answer = 42;\n");
  await mirador.replied(1, finished("done"));
  const id = mirador.page().id;
  const kept = mirador.captain.storage.get(`race:${id}`) as { race: Race };
  kept.race.racers[1]!.state = "checking";
  mirador.captain.storage.set(`race:${id}`, kept);
  const leftover = leftoverCheck();
  mirador.captain.storage.set(`check:${id}:2`, leftover);

  expect(await mirador.act({ kind: "resume" })).toEqual({ resuming: true });
  await mirador.act({ kind: "resume" });
  await until(() => mirador.page().phase === "picking", "the race over once racer 2 was checked again");

  expect(isAlive(leftover.pid), "what was left of the old check").toBe(false);
  expect(mirador.page().racers[1]).toMatchObject({ state: "finished", check: { outcome: "passed", exitCode: 0 } });
  expect(readFileSync(runs, "utf8"), "racer 1's check, then racer 2's once").toBe("ran\nran\n");
  expect(mirador.captain.storage.get(`check:${id}:2`)).toBeUndefined();
  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  expect(told?.text).toContain(`answer in one line that race ${id} is over and waits for their pick.`);
});

test("a race whose racers had all ended when Mirador restarted, before it moved on, moves on to the pick once its page shows", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  await mirador.replied(1, finished("done"));
  const id = mirador.page().id;
  const kept = mirador.captain.storage.get(`race:${id}`) as { race: Race };
  Object.assign(kept.race.racers[1]!, { state: "finished", endedAt: Date.now() });
  mirador.captain.storage.set(`race:${id}`, kept);

  await mirador.act({ kind: "resume" });
  await until(() => mirador.page().phase === "picking", "the race over");

  expect(mirador.promptsTo(mirador.captain.conversationId)).toHaveLength(1);
  await mirador.act({ kind: "resume" });
  expect(mirador.promptsTo(mirador.captain.conversationId), "a race already over isn't told twice").toHaveLength(1);
});

test("the page shows a racer's changes as a patch, as race_peek does", async () => {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2 });
  writeFileSync(join(mirador.started[1]!.folder, "app.ts"), "export const answer = 42;\n");

  const { diff } = (await mirador.act({ kind: "diff", racer: 2 })) as { diff: string };

  expect(diff).toContain("+export const answer = 42;");
  expect(await mirador.act({ kind: "diff", racer: 1 })).toEqual({ diff: "Racer 1 hasn't changed anything yet." });
});

test("`raceRequest` refuses check files without a check, or not as a full path", () => {
  expect(raceRequest({ task: "t", profile: "p", checkFiles: "/tmp/hidden" })).toBe("Hidden check files need a check to run them: give the check too.");
  expect(raceRequest({ task: "t", profile: "p", check: "true", checkFiles: "hidden/relative" })).toBe("Give the hidden check files' folder as a full path.");
  expect(raceRequest({ task: "t", profile: "p", check: "true", checkFiles: "   " })).toMatchObject({ checkFiles: null });
  expect(raceRequest({ task: "t", profile: "p", check: "true", checkFiles: " /tmp/hidden " })).toMatchObject({ check: "true", checkFiles: "/tmp/hidden" });
});

test("`raceRequest` takes a judge, trimmed, and a blank one is no judge", () => {
  expect(raceRequest({ task: "t", profile: "p", judge: " Kimi " })).toMatchObject({ judge: "Kimi" });
  expect(raceRequest({ task: "t", profile: "p", judge: "   " })).toMatchObject({ judge: null });
  expect(raceRequest({ task: "t", profile: "p" })).toMatchObject({ judge: null });
});

test("a race with hidden check files runs its check with them, and the racer's folder is as it was after", async () => {
  const mirador = fakeMirador();
  const hidden = join(scratch, "hidden");
  await mkdir(hidden, { recursive: true });
  writeFileSync(join(hidden, "check.sh"), "exit 0\n");
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, check: "sh check.sh", checkFiles: hidden });
  for (const { folder } of mirador.started) writeFileSync(join(folder, "check.sh"), "exit 1\n");
  expect(mirador.started[0]!.prompt, "the racer isn't told of the hidden check files").not.toContain(hidden);

  await mirador.replied(1, finished("done"));
  await mirador.replied(2, finished("done"));

  expect(mirador.page().racers.map(({ check }) => check?.outcome)).toEqual(["passed", "passed"]);
  for (const { folder } of mirador.started) expect(readFileSync(join(folder, "check.sh"), "utf8")).toBe("exit 1\n");
});

test("a check a restart cut short puts the racer's own files back before it copies the hidden ones again", async () => {
  const mirador = fakeMirador();
  const hidden = join(scratch, "hidden");
  await mkdir(hidden, { recursive: true });
  writeFileSync(join(hidden, "check.sh"), "echo hidden\n");
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, check: "sh check.sh", checkFiles: hidden });
  const folder2 = mirador.started[1]!.folder;
  writeFileSync(join(mirador.started[0]!.folder, "check.sh"), "echo own\nexit 1\n");
  await mirador.replied(1, finished("done"));

  writeFileSync(join(folder2, "check.sh"), "echo own\nexit 1\n");
  const kept = await copyCheckFilesOver(hidden, folder2);
  const id = mirador.page().id;
  const keptRace = mirador.captain.storage.get(`race:${id}`) as { race: Race };
  keptRace.race.racers[1]!.state = "checking";
  mirador.captain.storage.set(`race:${id}`, keptRace);
  mirador.captain.storage.set(`ownFiles:${id}:2`, kept);

  await mirador.act({ kind: "resume" });
  await until(() => mirador.page().phase === "picking", "the race over once racer 2 was checked again");

  expect(readFileSync(join(folder2, "check.sh"), "utf8")).toBe("echo own\nexit 1\n");
  expect(mirador.page().racers[1]!.check).toMatchObject({ outcome: "passed", output: "hidden\n" });
  expect(mirador.captain.storage.get(`ownFiles:${id}:2`)).toBeUndefined();
  expect(existsSync(kept.backup), "the cut-short check's backup is taken away").toBe(false);
});

test("a draft or a start naming a hidden check files folder that doesn't exist is refused", async () => {
  const gone = join(scratch, "gone");
  const notFolder = join(scratch, "afile");
  writeFileSync(notFolder, "x");
  const refusal = (path: string) => `There is no folder ${path} for the hidden check files.`;

  const agent = fakeMirador({ caller: "agent" });
  await expect(agent.call(agent.captain, "race", { task: "t", profile: "Qwen Flash", check: "true", checkFiles: gone })).rejects.toThrow(refusal(gone));

  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", {});
  await expect(mirador.act({ kind: "start", task: "t", profiles: ["Qwen Flash"], check: "true", checkFiles: gone })).rejects.toThrow(refusal(gone));
  await expect(mirador.call(mirador.captain, "race", { task: "t", profile: "Qwen Flash", check: "true", checkFiles: gone })).rejects.toThrow(refusal(gone));
  await expect(mirador.call(mirador.captain, "race", { task: "t", profile: "Qwen Flash", check: "true", checkFiles: notFolder })).rejects.toThrow(refusal(notFolder));
});

test("the captain hears that the check ran with the hidden check files", async () => {
  const mirador = fakeMirador();
  const hidden = join(scratch, "hidden");
  await mkdir(hidden, { recursive: true });
  writeFileSync(join(hidden, "check.sh"), "exit 0\n");
  await mirador.call(mirador.captain, "race", { task: "Make answer 42", profile: "Qwen Flash", racers: 2, check: "sh check.sh", checkFiles: hidden });
  for (const number of [1, 2]) await mirador.replied(number, finished("done"));

  const [told] = mirador.promptsTo(mirador.captain.conversationId);
  expect(told?.text).toMatch(/check passed in [\d.]+ s, with the hidden check files/);
});

test("a check queue passes a check's own time limit on", async () => {
  const options: { timeoutMs?: number }[] = [];
  const queue = new CheckQueue(1, (_command, _folder, given): RunningCheck => {
    options.push(given);
    return { pid: null, result: Promise.resolve({ outcome: "passed", exitCode: 0, durationMs: 0, output: "" }), stop() {} };
  });

  await queue.check("a", "true", scratch, undefined, { timeoutMs: 1234 });
  await queue.check("a", "true", scratch);

  expect(options).toStrictEqual([{ timeoutMs: 1234 }, { timeoutMs: undefined }]);
});
