import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

test("the agent's race waits as a filled-in form for the user's Start, then starts its racers in worktrees of their own, each in a lane, and the captain hears where they worked and waits for the user's pick", async ({ page }) => {
  await helpers().signIn(page, host);
  await helpers().addWorkspace(page, host.projectDir);
  const profiles = await helpers().createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  captainId = await startConversationWithoutModel(page);
  await sendAndWait(page, "Start");

  const drafted = await helpers().callCanvasTool(host, captainId, "race", { task: "FOLDER", profile: profileName, racers: 2, check: 'echo "checked in $PWD"', advice: "Hidden tests fit: parse has clear right answers." });
  expect(drafted).toContain("Nothing runs until the user checks it and presses Start race");
  const view = helpers().walkthroughView(page);
  const lane = (number: number) => view.locator(`.lane[data-racer="${number}"]`);

  await test.step("the form shows what the agent asked for, and no racer starts until the user presses Start race", async () => {
    await expect(view.getByRole("heading", { name: "New race" })).toBeVisible();
    await expect(view.getByLabel("Task")).toHaveValue("FOLDER");
    await expect(view.getByRole("note")).toHaveText("The captain advises: Hidden tests fit: parse has clear right answers.");
    await expect(view.getByLabel("Check", { exact: true })).toHaveValue('echo "checked in $PWD"');
    for (const number of [1, 2]) await expect(view.getByLabel(`Racer ${number}'s profile`)).toHaveValue(profileName);
    await expect(view.getByLabel("Racer 3's profile")).toHaveCount(0);
    expect(raceBranches()).toEqual([]);
    await helpers().untilFramePainted(page, raceFrame(page));
    await view.getByRole("button", { name: "Start race" }).click();
  });
  const heading = view.getByRole("heading", { name: /^Race \w+$/ });
  await expect(heading).toBeVisible();
  const raceId = (await heading.textContent())!.replace("Race ", "");

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
  await test.step("once both finished, Race runs the check in each one's folder, and the captain hears where each worked and waits for the user's pick", async () => {
    await expect.poll(agentSaw).toContain(`answer in one line that race ${raceId} is over and waits for their pick.`);
    expect(agentSaw()).toContain(`FOLDER\n\n---\nYou are racer 1 of 2 in race ${raceId}`);
    expect(agentSaw()).toContain(`FOLDER\n\n---\nYou are racer 2 of 2 in race ${raceId}`);
    decided = agentSaw().slice(agentSaw().indexOf(`Race ${raceId} is over`));
    const workedIn = [...decided.matchAll(/It said: Working in (\S+)/g)].map(([, folder]) => realpathSync(folder!));
    const toldOf = [...decided.matchAll(/ · folder (\S+) · /g)].map(([, folder]) => realpathSync(folder!));
    expect(new Set(workedIn).size, "each racer worked in a folder of its own").toBe(2);
    expect(toldOf.toSorted(), "the captain hears the folders the racers worked in").toEqual(workedIn.toSorted());
    for (const branch of raceBranches()) expect(decided).toContain(`branch ${branch} ·`);
    expect(decided).toMatch(/- Racer 1 \(racer\): finished · .* · check passed in [\d.]+ s/);
    await expect(view.getByText("Over: pick the work to take", { exact: false })).toBeVisible();
    await expect(view.locator(".lane .state-finished")).toHaveCount(2);
    await expect(view.getByRole("table", { name: "Results" }).getByRole("button", { name: "Take this" })).toHaveCount(2);
    await expect(view.locator(".lane .check")).toHaveCount(2);
    await expect(view.getByRole("region", { name: "Podium" }).locator(".step"), "both racers' work passed the check, so both earn a place").toHaveCount(2);
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

test("Stop race on the race page stops the racers still working, and the captain hears nothing of the race", async ({ page }) => {
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const composer = page.locator(".composer:visible textarea");
  await composer.fill(`/race:race task="STOPPED QUIET until the race is stopped. ${"Keep going until then. ".repeat(12).trim()}" profile=${profileName} racers=2`);
  await composer.press("Enter");
  const raceId = (await page.locator(".plugin-command-reply:visible").textContent())!.match(/Race (\w+) started/)![1]!;
  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
  await expect(view.locator(".lane .state-working")).toHaveCount(2);
  await expect(view.locator(".lane.running"), "a working racer's marker runs on its lane").toHaveCount(2);

  await expect(view.locator(".task"), "a long task shows folded").toHaveClass(/folded/);
  await view.getByRole("button", { name: "Show the whole task" }).click();
  await expect(view.locator(".task")).not.toHaveClass(/folded/);
  await expect(view.locator(".task")).toContainText("Keep going until then.");
  await view.getByRole("button", { name: "Fold the task" }).click();
  await expect(view.locator(".task")).toHaveClass(/folded/);

  await helpers().untilFramePainted(page, raceFrame(page));
  await view.getByRole("button", { name: "Stop race" }).click();
  await expect(view.getByText("Stopped ·", { exact: false })).toBeVisible();
  await expect(view.locator(".lane .state-stopped")).toHaveCount(2);
  await expect(view.locator(".lane.running")).toHaveCount(0);
  await expect(view.getByRole("button", { name: "Stop race" })).toHaveCount(0);

  await sendAndWait(page, "SAY Carrying on.");
  expect(agentSaw()).not.toContain(`Race ${raceId} is over`);
});

/** Saved as Mirador's profile editor saves it, with a model the editor only offers once the agent has listed it. */
async function saveProfileWithModel(page: Page, name: string, model: string, effort: string) {
  await page.evaluate(
    (profile) =>
      new Promise((resolve) => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
        socket.onopen = () => socket.send(JSON.stringify({ type: "profile.save", requestId: "save-model", profile }));
        socket.onmessage = ({ data }) => JSON.parse(String(data)).type === "profile.saved" && resolve(socket.close());
      }),
    { name, harness: "opencode", environment: "", prelaunch: "", model, mode: null, effort, bypassPermissions: false, askMode: "wait", color: null },
  );
}

test("/race:race with nothing after it shows a form, whose race waits for the user's pick, which goes to the captain as their message", async ({ page }) => {
  await helpers().signIn(page, host);
  await saveProfileWithModel(page, "thorough", "opus", "high");
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const composer = page.locator(".composer:visible textarea");
  await composer.fill("/race:race");
  await composer.press("Enter");
  await expect(composer).toHaveValue("/race:race ");
  await composer.press("Enter");
  await expect(page.locator(".plugin-command-reply:visible")).toContainText("Fill in the race on the canvas, then press Start race.");

  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: "New race" })).toBeVisible();
  for (const label of [`${profileName} · opencode`, "thorough · opus · high"]) await expect(view.getByLabel("Racer 1's profile").locator("option", { hasText: label })).toHaveCount(1);
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
  const hiddenDir = join(host.root, "hidden-checks");
  mkdirSync(hiddenDir, { recursive: true });
  writeFileSync(join(hiddenDir, "check.sh"), 'echo "checked in $PWD"\necho "hidden check"\n');
  await view.getByLabel("Hidden check files").fill(hiddenDir);
  await view.getByLabel("Check", { exact: true }).fill("sh check.sh");
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
  await expect(lane.locator(".check pre"), "what Race's run of the user's check printed in racer 1's folder").toContainText(/^checked in \/.+\/\S+$/m);
  await expect(lane.locator(".check pre"), "the check ran with the hidden check files").toContainText("hidden check");
  expect(agentSaw()).toMatch(/- Racer 1 \(racer\): finished · .* · check passed in [\d.]+ s/);
  await expect(view.locator(".race-head .meta"), "the meta line says the check ran with hidden check files").toContainText("with hidden check files");
  await expect(view.locator(".race-head .meta span", { hasText: "with hidden check files" })).toHaveAttribute("title", hiddenDir);
  const decided = agentSaw().slice(agentSaw().indexOf(`Race ${raceId} is over`));
  const folders = [...decided.matchAll(/ · folder (\S+) · /g)].map(([, folder]) => folder!);
  expect(folders, "the captain hears both racers' folders").toHaveLength(2);
  for (const folder of folders) expect(existsSync(join(folder, "check.sh")), "the hidden check.sh was taken back after the check").toBe(false);

  const podium = view.getByRole("region", { name: "Podium" });
  await expect(podium.locator(".step"), "both racers' work passed the check, so both earn a place").toHaveCount(2);
  expect((await view.locator(".lane .place").allTextContents()).toSorted()).toEqual(["1st", "2nd"]);
  const winner = await podium.locator(".step-1").getAttribute("data-racer");
  await expect(view.locator(`.lane[data-racer="${winner}"] .place`), "the lanes and the podium agree on the winner").toHaveText("1st");

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
  await expect(view.getByRole("region", { name: "Podium" }), "the race has no check, so no work earned a place").toHaveCount(0);
  await expect(view.locator(".lane .place")).toHaveCount(0);
  const results = view.getByRole("table", { name: "Results" });
  await helpers().untilFramePainted(page, raceFrame(page));
  for (const number of [1, 2]) await results.locator(`tr[data-racer="${number}"]`).getByRole("checkbox", { name: "Combine" }).check();
  await view.getByLabel("How to combine them").fill("racer 1's parser with racer 2's tests");
  await view.getByRole("button", { name: "Combine…" }).click();

  await expect.poll(agentSaw).toContain(`Combine the work of racers 1, 2 from race ${raceId} in your branch:`);
  expect(agentSaw()).toContain("How to combine them: racer 1's parser with racer 2's tests");
  await expect(view.getByText("You asked to combine racers 1, 2; the conversation that started the race is on it.")).toBeVisible();
});

test("a race with a judge starts it once the racers are checked, and goes on to the pick when the judge ends without scoring, saying so", async ({ page }) => {
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const composer = page.locator(".composer:visible textarea");
  await composer.fill(`/race:race task="FOLDER judged" profile=${profileName} racers=2 judge=${profileName}`);
  await composer.press("Enter");
  await expect(page.locator(".plugin-command-reply:visible")).toContainText("When all have finished, you pick the work to take on the race page.");
  const raceId = (await page.locator(".plugin-command-reply:visible").textContent())!.match(/Race (\w+) started/)![1]!;
  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
  await expect(view.locator(".race-head .meta"), "the meta line says who judges").toContainText(`judged by ${profileName}`);

  await expect.poll(agentSaw, "the judge was given the task").toContain(`You judge race ${raceId}`);
  const judgeRow = page.locator(".sidebar li[data-reorder-id]", { hasText: `Race ${raceId} · judge` });
  if ((await judgeRow.count()) === 0) await page.locator(`.sidebar li[data-reorder-id="${captainId}"] .delegated-toggle`).click();
  await expect(judgeRow, "the judge's conversation shows under the captain").toHaveCount(1);

  await expect(view.getByText("The judge (racer) gave no scores: it ended its turn without scoring.")).toBeVisible();
  await expect(view.getByRole("table", { name: "Results" }).getByRole("columnheader", { name: "Judge" })).toBeVisible();
  await expect.poll(agentSaw, "the captain hears the judge gave no scores").toContain("The judge (racer) gave no scores");
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

test("Delete the racers, once the work is taken, deletes their conversations and worktrees and keeps their changes on the page", async ({ page }) => {
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const composer = page.locator(".composer:visible textarea");
  await composer.fill(`/race:race task="FOLDER deleted" profile=${profileName} racers=2`);
  await composer.press("Enter");
  const raceId = (await page.locator(".plugin-command-reply:visible").textContent())!.match(/Race (\w+) started/)![1]!;
  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
  await expect.poll(agentSaw).toContain(`answer in one line that race ${raceId} is over and waits for their pick.`);

  const decided = agentSaw().slice(agentSaw().indexOf(`Race ${raceId} is over`));
  const folderOf = (number: number) => decided.match(new RegExp(`- Racer ${number} \\(racer\\): finished · branch \\S+ · folder (\\S+) ·`))![1]!;
  const branchOf = (number: number) => decided.match(new RegExp(`- Racer ${number} \\(racer\\): finished · branch (\\S+) ·`))![1]!;
  writeFileSync(join(folderOf(1), "kept.ts"), "export const kept = 1;\n");
  writeFileSync(join(folderOf(2), "kept.ts"), "export const kept = 2;\n");
  const racers = await racerConversations(page, captainId, raceId);

  const results = view.getByRole("table", { name: "Results" });
  await expect(results.locator("tbody tr")).toHaveCount(2);
  await expect(view.getByRole("button", { name: "Delete the racers" }), "the race waits for the pick, so nothing offers to delete yet").toHaveCount(0);
  await results.locator('tr[data-racer="1"]').getByRole("button", { name: "Take this" }).click();
  await expect.poll(agentSaw).toContain(`Take racer 1's work from race ${raceId} into your branch:`);
  await expect(view.getByText("You took racer 1's work; the conversation that started the race is on it.")).toBeVisible();
  await expect(page.locator(".chat-header:visible .badge"), "the captain answered the pick and its turn ended").toHaveText("idle", { timeout: 60_000 });

  await view.getByRole("button", { name: "Delete the racers" }).click();
  await expect(view.getByText("This deletes each racer's conversation, worktree and branch. Their changes stay on this page.")).toBeVisible();
  await view.getByRole("button", { name: "Delete them" }).click();
  await expect(view.getByText("The racers were deleted; their changes stay on this page.")).toBeVisible();

  for (const id of racers.values()) await expect(page.locator(`.sidebar li[data-reorder-id="${id}"]`), "the racers' conversations leave the sidebar").toHaveCount(0);
  for (const number of [1, 2]) {
    await expect.poll(() => existsSync(folderOf(number)), `racer ${number}'s worktree folder is gone`).toBe(false);
    await expect.poll(() => raceBranches().includes(branchOf(number)), `racer ${number}'s branch is gone`).toBe(false);
  }
  const lane = view.locator('.lane[data-racer="1"]');
  await expect(lane.getByRole("button", { name: "Open" }), "a deleted racer has no conversation to open").toHaveCount(0);
  await lane.getByRole("button", { name: "Changes" }).click();
  await expect(lane.getByLabel("Changes"), "racer 1's Changes still shows its file").toContainText("+++ b/kept.ts");
  await expect(lane.getByLabel("Changes")).toContainText("+export const kept = 1;");
});
