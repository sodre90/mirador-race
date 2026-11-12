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

const raceFrame = (page: Page) => page.locator(".canvas-panel:visible .canvas-body > .canvas-frame.plugin iframe");

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

test("a race starts its racers in worktrees of their own, shows each in a lane, and tells the captain their branches and folders and to run the check", async ({ page }) => {
  await helpers().signIn(page, host);
  await helpers().addWorkspace(page, host.projectDir);
  const profiles = await helpers().createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  captainId = await startConversationWithoutModel(page);
  await sendAndWait(page, "Start");

  const started = await helpers().callCanvasTool(host, captainId, "race", { task: "FOLDER", profile: profileName, racers: 2, check: 'echo "checked in $PWD"' });
  expect(started).toMatch(/^Race \w+ started: 2 racers, each in a worktree of its own \(racer 1 on racer, branch mirador\/\S+; racer 2 on racer, branch mirador\/\S+\)\./);
  const raceId = started.match(/^Race (\w+) started/)![1]!;
  const view = helpers().walkthroughView(page);
  const lane = (number: number) => view.locator(`.lane[data-racer="${number}"]`);

  await test.step("the racers show folded under the captain, and the race page gives each a lane on a branch of its own", async () => {
    await expect(page.locator(`.sidebar li[data-reorder-id="${captainId}"]`).getByRole("button", { name: "2 delegated" })).toBeVisible();
    await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
    await expect(view.getByText("FOLDER", { exact: true })).toBeVisible();
    const looseText = await view.locator("main").evaluate((main) => [...main.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent));
    expect(looseText, "a race nobody votes on yet shows no vote, not the word null").toEqual([]);
    await expect(view.locator(".lane")).toHaveCount(2);
    await expect(lane(1).locator("header .meta")).toHaveText(profileName);
    await expect.poll(raceBranches, "Mirador makes each racer's worktree after the race page shows it").toHaveLength(2);
    for (const branch of raceBranches()) await expect(view.locator(".lanes")).toContainText(branch);
  });

  let decided = "";
  await test.step("once both finished, the captain hears where each worked, and to run the agent's check itself, through its permissions", async () => {
    await expect.poll(agentSaw).toContain(`Race ${raceId} is over: 2 of 2 racers finished.`);
    expect(agentSaw()).toContain(`FOLDER\n\n---\nYou are racer 1 of 2 in race ${raceId}`);
    expect(agentSaw()).toContain(`FOLDER\n\n---\nYou are racer 2 of 2 in race ${raceId}`);
    decided = agentSaw().slice(agentSaw().indexOf(`Race ${raceId} is over`));
    const workedIn = [...decided.matchAll(/It said: Working in (\S+)/g)].map(([, folder]) => realpathSync(folder!));
    const toldOf = [...decided.matchAll(/ · folder (\S+) · /g)].map(([, folder]) => realpathSync(folder!));
    expect(new Set(workedIn).size, "each racer worked in a folder of its own").toBe(2);
    expect(toldOf.toSorted(), "the captain hears the folders the racers worked in").toEqual(workedIn.toSorted());
    for (const branch of raceBranches()) expect(decided).toContain(`branch ${branch} ·`);
    expect(decided).toContain("1. Run `echo \"checked in $PWD\"` in each finished racer's folder.");
    await expect(view.getByText("Over: the conversation that started it is taking the work", { exact: false })).toBeVisible();
    await expect(view.locator(".lane .state-finished")).toHaveCount(2);
    await expect(view.getByRole("button", { name: "Take this" }), "the agent started this race, so it picks").toHaveCount(0);
    await expect(view.locator(".lane .check"), "Race runs only a check the user typed").toHaveCount(0);
    await helpers().untilFramePainted(page, raceFrame(page));
  });

  const racers = await racerConversations(page, captainId, raceId);
  const folderOf = (number: number) => decided.match(new RegExp(`- Racer ${number} \\(racer\\): finished · branch \\S+ · folder (\\S+) ·`))![1]!;

  await test.step("a racer's note shows in its lane and on the board, and the next racer to read the board gets it once", async () => {
    const answer = await helpers().callCanvasTool(host, racers.get(1)!, "race_board", { post: "The bug is in parse.ts: it never trims." });
    expect(answer).toContain(`Race ${raceId} board. You are racer 1.`);
    expect(answer).toContain("No new notes from the others.");
    await expect(view.locator(".note-card", { hasText: "The bug is in parse.ts: it never trims." })).toContainText("Racer 1 ·");
    await expect(lane(1).locator(".note")).toHaveText("“The bug is in parse.ts: it never trims.”");

    const read = await helpers().callCanvasTool(host, racers.get(2)!, "race_board", {});
    expect(read).toContain("racer 1 (just now): The bug is in parse.ts: it never trims.");
    expect(await helpers().callCanvasTool(host, racers.get(2)!, "race_board", {})).toContain("No new notes from the others.");
  });

  await test.step("a racer's changes since the race began show in its lane, new files that aren't committed included, as race_peek gives them", async () => {
    expect(await helpers().callCanvasTool(host, captainId, "race_peek", { racer: 2 })).toBe("Racer 2 hasn't changed anything yet.");
    writeFileSync(join(folderOf(2), "trim.ts"), "export const trim = (text: string) => text.trim();\n");
    const diff = await helpers().callCanvasTool(host, captainId, "race_peek", { racer: 2 });
    expect(diff).toContain("+++ b/trim.ts");
    await expect(lane(2)).toContainText("1 file, +1 −0");

    await lane(2).getByRole("button", { name: "Changes" }).click();
    await expect(lane(2).getByLabel("Changes")).toContainText("+export const trim = (text: string) => text.trim();");
    await lane(2).getByRole("button", { name: "Hide changes" }).click();
    await expect(lane(2).getByLabel("Changes")).toHaveCount(0);
    expect(git("-C", folderOf(2), "status", "--porcelain"), "looking leaves the racer's staging as it was").toBe("?? trim.ts");
  });

  await test.step("Open in a racer's lane opens its conversation", async () => {
    await lane(1).getByRole("button", { name: "Open" }).click();
    await expect(page).toHaveURL(new RegExp(`#/c/${racers.get(1)}$`));
    await page.goto(`${host.origin}/#/c/${captainId}`);
    await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
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
  await expect(view.locator(".lane .state-working")).toHaveCount(2);

  await helpers().untilFramePainted(page, raceFrame(page));
  await view.getByRole("button", { name: "Stop race" }).click();
  await expect(view.getByText("Stopped ·", { exact: false })).toBeVisible();
  await expect(view.locator(".lane .state-stopped")).toHaveCount(2);
  await expect(view.getByRole("button", { name: "Stop race" })).toHaveCount(0);

  await sendAndWait(page, "SAY Carrying on.");
  expect(agentSaw()).not.toContain(`Race ${raceId} is over`);
});

test("/race:race with nothing after it shows a form, whose race waits for the user's pick, which goes to the captain as their message", async ({ page }) => {
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const composer = page.locator(".composer:visible textarea");
  await composer.fill("/race:race");
  await composer.press("Enter");
  await expect(composer).toHaveValue("/race:race ");
  await composer.press("Enter");
  await expect(page.locator(".plugin-command-reply:visible")).toContainText("Fill in the race on the canvas, then press Start race.");

  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: "New race" })).toBeVisible();
  await expect(view.getByLabel("Racer 1's profile").locator("option", { hasText: `${profileName} · opencode` })).toHaveCount(1);
  await helpers().untilFramePainted(page, raceFrame(page));
  await view.getByRole("button", { name: "Start race" }).click();
  await expect(view.getByRole("alert")).toHaveText("Say what the racers should do: the task.");

  await view.getByLabel("Task").fill("FOLDER from the form");
  await view.getByRole("button", { name: "Add a racer" }).click();
  await expect(view.getByLabel("Racer 5's profile")).toBeVisible();
  await view.getByRole("button", { name: "Remove racer 5" }).click();
  await view.getByRole("button", { name: "Remove racer 4" }).click();
  await view.getByRole("button", { name: "Remove racer 3" }).click();
  await expect(view.getByRole("button", { name: /^Remove racer/ }), "a race keeps at least two racers").toHaveCount(0);
  for (const number of [1, 2]) await view.getByLabel(`Racer ${number}'s profile`).selectOption(profileName);
  await view.getByLabel("Check").fill('echo "checked in $PWD"');
  await view.getByRole("button", { name: "Start race" }).click();

  const heading = view.getByRole("heading", { name: /^Race \w+$/ });
  await expect(heading).toBeVisible();
  const raceId = (await heading.textContent())!.replace("Race ", "");
  await expect(view.locator(".lane")).toHaveCount(2);

  await expect.poll(agentSaw).toContain(`answer in one line that race ${raceId} is over and waits for their pick.`);
  await expect(view.getByText("Over: pick the work to take", { exact: false })).toBeVisible();
  const results = view.getByRole("table", { name: "Results" });
  await expect(results.locator("tbody tr")).toHaveCount(2);
  await expect(results.locator('tr[data-racer="2"]')).toContainText(/Passed in [\d.]+ s/);
  const lane = view.locator('.lane[data-racer="1"]');
  await lane.getByText(/^Check passed in [\d.]+ s$/).click();
  await expect(lane.locator(".check pre"), "what Race's run of the user's check printed in racer 1's folder").toContainText(/^checked in \/.+\/\S+\n?$/);
  expect(agentSaw()).toMatch(/- Racer 1 \(racer\): finished · .* · check passed in [\d.]+ s/);

  await results.locator('tr[data-racer="2"]').getByRole("button", { name: "Take this" }).click();
  await expect.poll(agentSaw).toContain(`Take racer 2's work from race ${raceId} into your branch:`);
  await expect(page.locator(".timeline:visible .message.user").last()).toContainText(`Take racer 2's work from race ${raceId}`);
  await expect(view.getByText("You took racer 2's work; the conversation that started the race is on it.")).toBeVisible();
  await expect(view.getByRole("button", { name: "Take this" })).toHaveCount(0);
});

test("/race:race with a task and a profile starts the race at once, and ticking racers to Combine… asks the captain for the parts the user wants", async ({ page }) => {
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const composer = page.locator(".composer:visible textarea");
  await composer.fill(`/race:race task="FOLDER combined" profile=${profileName} racers=2`);
  await composer.press("Enter");
  await expect(page.locator(".plugin-command-reply:visible")).toContainText("When all have finished, you pick the work to take on the race page.");
  const raceId = (await page.locator(".plugin-command-reply:visible").textContent())!.match(/Race (\w+) started/)![1]!;

  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
  await expect(view.getByText("Over: pick the work to take", { exact: false })).toBeVisible();
  const results = view.getByRole("table", { name: "Results" });
  await helpers().untilFramePainted(page, raceFrame(page));
  for (const number of [1, 2]) await results.locator(`tr[data-racer="${number}"]`).getByRole("checkbox", { name: "Combine" }).check();
  await view.getByLabel("How to combine them").fill("racer 1's parser with racer 2's tests");
  await view.getByRole("button", { name: "Combine…" }).click();

  await expect.poll(agentSaw).toContain(`Combine the work of racers 1, 2 from race ${raceId} in your branch:`);
  expect(agentSaw()).toContain("How to combine them: racer 1's parser with racer 2's tests");
  await expect(view.getByText("You asked to combine racers 1, 2; the conversation that started the race is on it.")).toBeVisible();
});

test("a check a restart of Mirador cut short runs again once the race page shows, and the race then waits for the user's pick", async ({ page }) => {
  const release = join(host.root, "release-checks");
  const check = join(host.root, "check.sh");
  writeFileSync(check, `while [ ! -e ${release} ]; do sleep 0.2; done; echo "checked after the restart"\n`);
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const composer = page.locator(".composer:visible textarea");
  await composer.fill(`/race:race task="FOLDER restarted" profile=${profileName} racers=2 check="sh ${check}"`);
  await composer.press("Enter");
  const raceId = (await page.locator(".plugin-command-reply:visible").textContent())!.match(/Race (\w+) started/)![1]!;
  const view = helpers().walkthroughView(page);
  await expect(view.locator(".lane .state.state-checking")).toHaveCount(2);

  await host.restart();
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
  await expect(view.locator(".lane .state.state-checking"), "the checks run again, as the release isn't there yet").toHaveCount(2);
  writeFileSync(release, "");

  await expect(view.getByText("Over: pick the work to take", { exact: false })).toBeVisible({ timeout: 30_000 });
  const results = view.getByRole("table", { name: "Results" });
  await expect(results.locator("tbody tr")).toHaveCount(2);
  await expect(results.getByText(/Passed in [\d.]+ s/)).toHaveCount(2);
  await expect.poll(agentSaw).toContain(`answer in one line that race ${raceId} is over and waits for their pick.`);
});
