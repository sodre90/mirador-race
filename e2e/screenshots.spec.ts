import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { helpers, startHostWithThisPlugin, type TestHost } from "./mirador.ts";

/** Opt-in because it is not a test: MIRADOR_SCREENSHOTS=1 scripts/e2e.sh e2e/screenshots.spec.ts */
test.skip(process.env.MIRADOR_SCREENSHOTS !== "1", "set MIRADOR_SCREENSHOTS=1 to retake the plugin's screenshots");

const screenshotsDirectory = process.env.SCREENSHOTS_DIR!;
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });

let host: TestHost;
test.beforeAll(async () => {
  ({ host } = await startHostWithThisPlugin());
  writeProject(host.projectDir, { "src/paginate.ts": BUGGY_PAGINATE, "src/paginate.test.ts": FIRST_TEST });
  git(host.projectDir, "init", "-q", "--initial-branch=main");
  git(host.projectDir, "config", "user.name", "The Owner");
  git(host.projectDir, "config", "user.email", "owner@example.test");
  git(host.projectDir, "add", "-A");
  git(host.projectDir, "commit", "-qm", "Orders list");
});
test.afterAll(async () => {
  await host?.stop();
  await host?.cleanUp();
});

const captainProfile = "main-model";
const racerProfiles = ["qwen3-coder", "qwen3-coder", "kimi-k2", "glm-4.6"];
const task = "Page 1 of the orders list skips the first 20 orders, and the last page is always empty. Fix paginate() in src/paginate.ts so pages count from 1, and add tests for the first, the last and an empty list.";
/** The stand-in agent works until it is stopped, then ends its turn as finished; the pictures show the task without this. */
const WORKS_UNTIL_STOPPED = "FINISHED ON STOP ";
const KEEPS_BUSY = "STOPPED QUIET until the screenshots are taken";
const request = "Page 1 of the orders list skips the first 20 orders, and the last page is always empty. Where's the bug?";
const captainsAnswer =
  "In paginate() in src/paginate.ts: pages count from 1, but the offset is page * size, so page 1 starts at order 21, and pages has a stray + 1. Race it with /race:race if you'd like a few takes on the fix to pick from.";

const BUGGY_PAGINATE = `export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
}

export function paginate<T>(items: T[], page: number, size = 20): Page<T> {
  const pages = Math.ceil(items.length / size) + 1;
  const start = page * size;
  return { items: items.slice(start, start + size), page, pages };
}
`;

const FIRST_TEST = `import { expect, test } from "bun:test";
import { paginate } from "./paginate.ts";

test("a page holds at most size items", () => {
  expect(paginate(Array.from({ length: 50 }, (_, index) => index), 2).items).toHaveLength(20);
});
`;

const OFFSET_ONLY_PAGINATE = BUGGY_PAGINATE.replace("page * size", "(page - 1) * size");

const FIXED_PAGINATE = BUGGY_PAGINATE.replace("Math.ceil(items.length / size) + 1", "Math.max(1, Math.ceil(items.length / size))").replace("page * size", "(page - 1) * size");

const CLAMPED_PAGINATE = `export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
}

export function paginate<T>(items: T[], page: number, size = 20): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const shown = Math.min(Math.max(1, Math.trunc(page)), pages);
  const start = (shown - 1) * size;
  return { items: items.slice(start, start + size), page: shown, pages };
}
`;

const orders = "const orders = Array.from({ length: 45 }, (_, index) => index + 1);\n";

const EDGE_TESTS = `${FIRST_TEST}
${orders}
test("page 1 starts with the first order", () => {
  expect(paginate(orders, 1).items[0]).toBe(1);
});

test("the last page holds what is left", () => {
  expect(paginate(orders, 3)).toEqual({ items: [41, 42, 43, 44, 45], page: 3, pages: 3 });
});

test("an empty list has one empty page", () => {
  expect(paginate([], 1)).toEqual({ items: [], page: 1, pages: 1 });
});
`;

const CLAMP_TESTS = `${EDGE_TESTS}
test("a page past the end shows the last page", () => {
  expect(paginate(orders, 9).page).toBe(3);
});

test("page 0 shows the first page", () => {
  expect(paginate(orders, 0).items[0]).toBe(1);
});
`;

const FIRST_PAGE_TEST = `${FIRST_TEST}
test("page 1 starts with the first order", () => {
  expect(paginate([1, 2, 3], 1).items).toEqual([1, 2, 3]);
});
`;

function git(folder: string, ...args: string[]) {
  return execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();
}

function writeProject(folder: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
}

function commitWork(folder: string, message: string) {
  git(folder, "add", "-A");
  git(folder, "-c", "user.name=Racer", "-c", "user.email=racer@example.test", "commit", "-qm", message);
}

/** Each racer's folder, by the branch its lane on the race page shows. */
async function racerFolders(view: FrameLocator) {
  const worktrees = git(host.projectDir, "worktree", "list", "--porcelain")
    .split("\n\n")
    .map((block) => ({ folder: block.match(/^worktree (.+)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] }));
  const folders = new Map<number, string>();
  for (const number of [1, 2, 3, 4]) {
    const branch = await view.locator(`.lane[data-racer="${number}"] .line code`).textContent();
    folders.set(number, worktrees.find((worktree) => worktree.branch === branch)!.folder!);
  }
  return folders;
}

async function startConversationWithoutModel(page: Page) {
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  return page.url().match(/#\/c\/(.+)$/)![1]!;
}

/** The racers' conversations, by number, as the sidebar lists them under the captain once unfolded. */
async function racerConversations(page: Page, captainId: string, raceId: string) {
  const rows = page.locator(".sidebar li[data-reorder-id]", { hasText: `Race ${raceId} · racer` });
  if ((await rows.count()) === 0) await page.locator(`.sidebar li[data-reorder-id="${captainId}"] .delegated-toggle`).click();
  await expect(rows).toHaveCount(4);
  const racers = new Map<number, string>();
  for (const row of await rows.all()) racers.set(Number((await row.textContent())!.match(/racer (\d)/)![1]), (await row.getAttribute("data-reorder-id"))!);
  return racers;
}

/**
 * The stand-in agents start with the stub's command words, which a real race's task and a real request don't have, and
 * the workspace sits in a temp folder.
 */
async function tidyForScreenshot(page: Page, view: FrameLocator) {
  await view.locator(".task").evaluate((element, command) => (element.textContent = element.textContent!.replace(command, "")), WORKS_UNTIL_STOPPED);
  await page.evaluate(
    ({ command, request }) => {
      const textNodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
        if (node.textContent?.startsWith("SAY ")) node.textContent = request;
        if (node.textContent?.includes(command)) node.textContent = node.textContent.replace(command, "");
        if (node.textContent?.startsWith("/var/folders") || node.textContent?.startsWith("/tmp/")) node.textContent = "~/code/project";
      }
    },
    { command: WORKS_UNTIL_STOPPED, request },
  );
}

/** The area, from the top of `from` and down to the bottom of `downTo` when given, which may sit in the race page's frame. */
async function takeScreenshot(page: Page, name: string, area: Locator, { from, downTo }: { from?: Locator; downTo?: Locator } = {}) {
  mkdirSync(screenshotsDirectory, { recursive: true });
  await page.mouse.move(0, 0);
  const margin = 6;
  const box = (await area.boundingBox())!;
  const first = from && (await from.boundingBox())!;
  const last = downTo && (await downTo.boundingBox())!;
  const top = first ? first.y - margin : box.y;
  const bottom = last ? Math.min(last.y + last.height + margin, box.y + box.height) : box.y + box.height;
  await page.screenshot({ path: join(screenshotsDirectory, `${name}.png`), clip: { x: box.x, y: top, width: box.width, height: bottom - top } });
}

test("screenshots of a race", async ({ page }) => {
  await helpers().signIn(page, host);
  await helpers().addWorkspace(page, host.projectDir);
  for (const name of new Set([captainProfile, ...racerProfiles])) {
    const profiles = await helpers().createProfile(page, name, "", "", "opencode");
    await profiles.getByRole("button", { name: "Close" }).click();
  }
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${captainProfile} · opencode` });
  const captainId = await startConversationWithoutModel(page);
  await helpers().sendMessage(page, `SAY ${captainsAnswer}`);
  await expect(page.locator(".chat-header:visible .badge")).toHaveText("idle", { timeout: 60_000 });

  const composer = page.locator(".composer:visible textarea");
  await composer.fill("/race:race");
  await composer.press("Enter");
  await composer.press("Enter");
  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: "New race" })).toBeVisible();
  await helpers().untilFramePainted(page, page.locator(".canvas-panel:visible .canvas-body > .canvas-frame.plugin iframe"));
  await view.getByLabel("Task").fill(task);
  for (const [index, profile] of racerProfiles.entries()) await view.getByLabel(`Racer ${index + 1}'s profile`).selectOption(profile);
  await view.getByLabel("Check").fill("bun test");
  await view.getByRole("checkbox", { name: "The racers rank each other's work before I pick" }).check();
  await page.mouse.move(0, 0);
  await takeScreenshot(page, "race-form", page.locator(".canvas-panel:visible"), { downTo: view.getByRole("button", { name: "Start race" }) });

  await view.getByLabel("Task").fill(`${WORKS_UNTIL_STOPPED}${task}`);
  await view.getByRole("button", { name: "Start race" }).click();
  const heading = view.getByRole("heading", { name: /^Race \w+$/ });
  await expect(heading).toBeVisible();
  const raceId = (await heading.textContent())!.replace("Race ", "");
  await expect(view.locator(".lane .state-working")).toHaveCount(4, { timeout: 60_000 });
  await page.locator(".plugin-command-reply:visible").getByRole("button", { name: "Dismiss" }).click();
  const folders = await racerFolders(view);
  const racers = await racerConversations(page, captainId, raceId);
  const post = (racer: number, text: string) => helpers().callCanvasTool(host, racer === 0 ? captainId : racers.get(racer)!, "race_board", { post: text });
  const peek = (by: number, racer: number) => helpers().callCanvasTool(host, racers.get(by)!, "race_peek", { racer });
  const lane = (number: number) => view.locator(`.lane[data-racer="${number}"]`);

  await post(1, "Plan: a failing test for page 1 first, then fix the offset in paginate().");
  await post(2, "Plan: check who calls paginate() before changing it; the orders API and the CSV export both do.");
  await post(3, "Found it: pages are 1-based but the offset is page * size, so page 1 starts at order 21. And pages has a stray + 1, hence the empty last page.");
  await post(0, "Keep paginate()'s signature as it is: the mobile app calls it too.");
  writeProject(folders.get(1)!, { "src/paginate.ts": FIXED_PAGINATE, "src/paginate.test.ts": EDGE_TESTS });
  writeProject(folders.get(2)!, { "src/paginate.ts": OFFSET_ONLY_PAGINATE, "src/paginate.test.ts": EDGE_TESTS });
  writeProject(folders.get(3)!, { "src/paginate.ts": CLAMPED_PAGINATE, "src/paginate.test.ts": CLAMP_TESTS });
  writeProject(folders.get(4)!, { "src/paginate.test.ts": EDGE_TESTS });
  await peek(4, 3);
  await post(4, "Took racer 3's finding. Writing the tests first: an empty list should give one empty page, not zero.");
  const racersToggle = page.locator(".delegated-tasks:visible .delegated-group-toggle");
  const showRacersUnderComposer = async () => {
    if ((await racersToggle.getAttribute("aria-expanded")) === "false") await racersToggle.click();
  };
  await showRacersUnderComposer();
  await expect(lane(4)).toContainText("1 file");
  await tidyForScreenshot(page, view);
  await takeScreenshot(page, "racers-beside-captain", page.locator("body"));

  commitWork(folders.get(1)!, "Count pages from 1 in paginate()");
  await post(1, "Done: the offset is (page - 1) * size and pages has no + 1. Tests for the first, the last and an empty list; bun test passes, 4 tests.");

  const stopRacer = async (number: number) => {
    await showRacersUnderComposer();
    await page.locator(".delegated-group-items:visible li", { hasText: `racer ${number} ` }).getByRole("button", { name: "Stop", exact: true }).click();
    await expect(lane(number).locator(".state-finished")).toBeVisible({ timeout: 60_000 });
  };
  /** A busy racer's vote prompt waits behind its turn, so the stand-in can't end the vote turn before its vote is cast. */
  const keepBusy = async (number: number) => {
    await page.goto(`${host.origin}/#/c/${racers.get(number)}`);
    await helpers().sendMessage(page, KEEPS_BUSY);
    await page.goto(`${host.origin}/#/c/${captainId}`);
    await expect(view.getByRole("heading", { name: `Race ${raceId}` })).toBeVisible();
  };

  await stopRacer(1);
  await keepBusy(1);
  await expect(lane(1)).toContainText("2 files");
  await expect(lane(1).locator(".check summary")).toHaveText(/^Check passed in [\d.]+ s$/);
  await helpers().untilFramePainted(page, page.locator(".canvas-panel:visible .canvas-body > .canvas-frame.plugin iframe"));
  await lane(3).getByRole("button", { name: "Changes" }).click();
  await expect(lane(3).getByLabel("Changes")).toContainText("Math.min(Math.max(1, Math.trunc(page)), pages)");
  await tidyForScreenshot(page, view);
  await takeScreenshot(page, "race-under-way", page.locator(".canvas-panel:visible"), { downTo: view.locator(".lanes") });
  await lane(3).getByRole("button", { name: "Hide changes" }).click();

  commitWork(folders.get(3)!, "Count pages from 1 and show the last page for one past the end");
  await post(3, "Done: offset from 1, no empty last page, and a page past the end shows the last one, as the API's clients expect. bun test passes, 6 tests.");
  commitWork(folders.get(2)!, "Fix the first page's offset");
  await post(2, "Done: page 1 starts at the first order. The last page is still empty: the CSV export counts on the + 1 in pages, so I left it.");
  await post(4, "Done: racer 3's fix with my edge tests. bun test passes, 4 tests.");
  writeProject(folders.get(4)!, { "src/paginate.ts": FIXED_PAGINATE });
  commitWork(folders.get(4)!, "Fix paginate() and test its edges");
  for (const number of [3, 2]) {
    await stopRacer(number);
    await keepBusy(number);
  }
  await stopRacer(4);
  await expect(view.getByText("The racers are voting", { exact: false })).toBeVisible();
  const votes: [number, number[], string][] = [
    [1, [3, 4, 2], "Racer 3 also clamps a page past the end, which the API's clients send, and tests it. Racer 4's is the same as mine. Racer 2 leaves the empty last page."],
    [2, [3, 1, 4], "Racer 3 covers every edge with tests. Racer 1 is right but doesn't clamp; racer 4 copied racer 3's tests without the clamp."],
    [3, [1, 4, 2], "Racer 1's fix is the smallest that passes the tests asked for. Racer 2's check fails: its last page is still empty."],
    [4, [3, 1, 2], "Racer 3's clamp handles page 0 from the CSV export, which racer 2 found. Racer 1 is right otherwise."],
  ];
  for (const [racer, ranking, why] of votes) await helpers().callCanvasTool(host, racers.get(racer)!, "race_vote", { ranking, why });
  await expect(view.getByText("Over: pick the work to take", { exact: false })).toBeVisible();
  await expect(view.getByRole("table", { name: "Results" }).locator('tr[data-racer="2"]')).toContainText("Failed (exit code 1)");
  await tidyForScreenshot(page, view);
  await takeScreenshot(page, "pick-the-work", page.locator(".canvas-panel:visible"), { downTo: view.getByRole("button", { name: "Let the captain pick" }) });
});
