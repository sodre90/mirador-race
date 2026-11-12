import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { helpers, startHostWithThisPlugin, type TestHost } from "./mirador.ts";

let host: TestHost;
let promptsFile: string;
const profileName = "racer";

/** Everything the stub agents were given, in order: the captain's prompts and the racers' alike. */
const agentSaw = () => readFileSync(promptsFile, "utf8");
const git = (...args: string[]) => execFileSync("git", ["-C", host.projectDir, ...args], { encoding: "utf8" }).trim();
const raceBranches = () => git("branch", "--list", "mirador/*", "--format=%(refname:short)").split("\n").filter(Boolean);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  ({ host, promptsFile } = await startHostWithThisPlugin());
  writeFileSync(join(host.projectDir, "parse.ts"), "export const parse = (text: string) => text;\n");
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "The Owner");
  git("config", "user.email", "owner@example.test");
  git("add", "-A");
  git("commit", "-qm", "base");
});
test.afterAll(async () => {
  await host?.stop();
  await host?.cleanUp();
});

/** The stub agent offers no model to pick, so this is `startConversation` without that wait. */
async function startConversationWithoutModel(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

async function sendAndWait(page: Page, text: string) {
  await helpers().sendMessage(page, text);
  await expect(page.locator(".chat-header:visible .badge")).toHaveText("idle", { timeout: 60_000 });
}

/** The racers' conversations, by number, as the sidebar lists them under the captain once unfolded. */
async function racerConversations(page: Page, captainId: string, raceId: string) {
  const rows = page.locator(".sidebar li[data-reorder-id]", { hasText: `Race ${raceId} · racer` });
  if ((await rows.count()) === 0) await page.locator(`.sidebar li[data-reorder-id="${captainId}"] .delegated-toggle`).click();
  await expect(rows).toHaveCount(2);
  const racers = new Map<number, string>();
  for (const row of await rows.all()) {
    const number = Number((await row.textContent())!.match(/racer (\d)/)![1]);
    racers.set(number, (await row.getAttribute("data-reorder-id"))!);
  }
  return racers;
}

let captainId = "";

test("a race starts its racers in worktrees of their own, shows them on its page, and tells the captain their branches and folders once they finish", async ({ page }) => {
  await helpers().signIn(page, host);
  await helpers().addWorkspace(page, host.projectDir);
  const profiles = await helpers().createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  captainId = await startConversationWithoutModel(page);
  await sendAndWait(page, "Start");

  const started = await helpers().callCanvasTool(host, captainId, "race", { task: "FOLDER", profile: profileName, racers: 2 });
  expect(started).toMatch(/^Race \w+ started: 2 racers on racer, each in a worktree of its own \(racer 1 on mirador\/\S+, racer 2 on mirador\/\S+\)\./);
  const raceId = started.match(/^Race (\w+) started/)![1]!;
  const view = helpers().walkthroughView(page);

  await test.step("the racers show folded under the captain, and the race page lists them, each on a branch of its own", async () => {
    await expect(page.locator(`.sidebar li[data-reorder-id="${captainId}"]`).getByRole("button", { name: "2 delegated" })).toBeVisible();
    await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
    await expect(view.getByText("FOLDER", { exact: true })).toBeVisible();
    const rows = view.getByRole("table", { name: "Racers" }).locator("tbody tr[data-racer]");
    await expect(rows).toHaveCount(2);
    await expect.poll(raceBranches, "Mirador makes each racer's worktree after the race page shows it").toHaveLength(2);
    for (const branch of raceBranches()) await expect(view.getByRole("table", { name: "Racers" })).toContainText(branch);
  });

  let decided = "";
  await test.step("each racer got the task first, then how to race, and the captain hears where each worked once both finished", async () => {
    await expect.poll(agentSaw).toContain(`Race ${raceId} is over: 2 of 2 racers finished.`);
    expect(agentSaw()).toContain(`FOLDER\n\n---\nYou are racer 1 of 2 in race ${raceId}`);
    expect(agentSaw()).toContain(`FOLDER\n\n---\nYou are racer 2 of 2 in race ${raceId}`);
    decided = agentSaw().slice(agentSaw().indexOf(`Race ${raceId} is over`));
    const workedIn = [...decided.matchAll(/It said: Working in (\S+)/g)].map(([, folder]) => realpathSync(folder!));
    const toldOf = [...decided.matchAll(/ · folder (\S+) · /g)].map(([, folder]) => realpathSync(folder!));
    expect(new Set(workedIn).size, "each racer worked in a folder of its own").toBe(2);
    expect(toldOf.toSorted(), "the captain hears the folders the racers worked in").toEqual(workedIn.toSorted());
    for (const branch of raceBranches()) expect(decided).toContain(`branch ${branch} ·`);
    await expect(view.getByText("Over: the conversation that started it is picking the best work", { exact: false })).toBeVisible();
    await expect(view.locator("tr[data-racer] .state-finished")).toHaveCount(2);
  });

  const racers = await racerConversations(page, captainId, raceId);
  const folderOf = (number: number) => decided.match(new RegExp(`- Racer ${number}: finished · branch \\S+ · folder (\\S+) ·`))![1]!;

  await test.step("a racer's note on the board shows on the race page, and the next racer to read the board gets it once", async () => {
    const answer = await helpers().callCanvasTool(host, racers.get(1)!, "race_board", { post: "The bug is in parse.ts: it never trims." });
    expect(answer).toContain(`Race ${raceId} board. You are racer 1.`);
    expect(answer).toContain("No new notes from the others.");
    await expect(view.locator(".note", { hasText: "The bug is in parse.ts: it never trims." })).toContainText("Racer 1 ·");

    const read = await helpers().callCanvasTool(host, racers.get(2)!, "race_board", {});
    expect(read).toContain("racer 1 (just now): The bug is in parse.ts: it never trims.");
    expect(await helpers().callCanvasTool(host, racers.get(2)!, "race_board", {})).toContain("No new notes from the others.");
  });

  await test.step("race_peek shows a racer's work since the race began, new files that aren't committed included, and the page counts it", async () => {
    expect(await helpers().callCanvasTool(host, captainId, "race_peek", { racer: 2 })).toBe("Racer 2 hasn't changed anything yet.");
    writeFileSync(join(folderOf(2), "trim.ts"), "export const trim = (text: string) => text.trim();\n");
    const diff = await helpers().callCanvasTool(host, captainId, "race_peek", { racer: 2 });
    expect(diff).toContain("+++ b/trim.ts");
    expect(diff).toContain("+export const trim");
    await expect(view.locator('tr[data-racer="2"]')).toContainText("1 file, +1 −0");
    expect(git("-C", folderOf(2), "status", "--porcelain"), "peeking leaves the racer's staging as it was").toBe("?? trim.ts");
  });

  await test.step("a conversation outside the race can't use its tools", async () => {
    await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
    const stranger = await startConversationWithoutModel(page);
    await sendAndWait(page, "Start");
    expect(await helpers().callCanvasTool(host, stranger, "race_board", {})).toContain("Only a race's racers and the conversation that started it use the race tools");
  });
});

test("Stop race on the race page stops the racers still working, and the captain isn't asked to decide", async ({ page }) => {
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const started = await helpers().callCanvasTool(host, captainId, "race", { task: "STOPPED QUIET until the race is stopped", profile: profileName, racers: 2 });
  const raceId = started.match(/^Race (\w+) started/)![1]!;
  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
  await expect(view.locator("tr[data-racer] .state-working")).toHaveCount(2);

  await helpers().untilFramePainted(page, page.locator(".canvas-panel:visible .canvas-body > .canvas-frame.plugin iframe"));
  await view.getByRole("button", { name: "Stop race" }).click();
  await expect(view.getByText("Stopped ·", { exact: false })).toBeVisible();
  await expect(view.locator("tr[data-racer] .state-stopped")).toHaveCount(2);
  await expect(view.getByRole("button", { name: "Stop race" })).toHaveCount(0);

  await sendAndWait(page, "SAY Carrying on.");
  expect(agentSaw()).not.toContain(`Race ${raceId} is over`);
});
