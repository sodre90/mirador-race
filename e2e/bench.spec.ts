import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { helpers, startHostWithThisPlugin, type TestHost } from "./mirador.ts";

let host: TestHost;
let promptsFile: string;
let captainId = "";
const profileName = "racer";

/** Everything the stub agents were given, in order: the captain's prompts and the racers' alike. */
const agentSaw = () => readFileSync(promptsFile, "utf8");
const git = (...args: string[]) => execFileSync("git", ["-C", host.projectDir, ...args], { encoding: "utf8" }).trim();
/** The stub agent writes relative to its own process's folder, not its session's, so the answer racer's file is an absolute one under the host's root, which its check reads. */
const answerFile = () => join(host.root, "answer.txt");

test.describe.configure({ mode: "serial" });

/** A problem of the set: its task word for word and its check, starting from a commit of the set's repository. */
function addProblem(id: string, task: string, check: string, start = `start/${id}`) {
  const folder = join(host.projectDir, "problems", id);
  mkdirSync(join(folder, "check"), { recursive: true });
  writeFileSync(join(folder, "problem.json"), JSON.stringify({ start, check }));
  writeFileSync(join(folder, "task.md"), task);
}

test.beforeAll(async () => {
  ({ host, promptsFile } = await startHostWithThisPlugin());
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "The Owner");
  git("config", "user.email", "owner@example.test");
  for (const id of ["answer", "never"]) {
    git("checkout", "-q", "--orphan", `start/${id}`);
    writeFileSync(join(host.projectDir, "README.md"), `# ${id}\n`);
    git("add", "-A");
    git("commit", "-qm", `start ${id}`);
  }
  git("checkout", "-q", "--orphan", "main");
  git("rm", "-rqf", ".");
  writeFileSync(join(host.projectDir, "set.json"), JSON.stringify({ name: "Tiny", tries: 2, checkTimeoutMinutes: 1 }));
  addProblem("answer", `WRITE [{"edit": ${JSON.stringify(answerFile())}, "content": "42\\n"}]`, `grep -qx 42 ${answerFile()}`);
  addProblem("never", "SAY I give up", "test -e done.txt");
  git("add", "-A");
  git("commit", "-qm", "set");
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

const benchFrame = (page: Page) => page.locator(".canvas-panel:visible .canvas-body > .canvas-frame.plugin iframe");

const racerBranches = () => git("branch", "--list", "mirador/*", "--format=%(refname:short)").split("\n").filter(Boolean);
/** The worktrees of the set's repository the racers work in, leaving out the set itself. */
const racerWorktrees = () =>
  git("worktree", "list", "--porcelain")
    .split("\n\n")
    .map((entry) => entry.match(/^worktree (.+)$/m)?.[1])
    .filter((folder): folder is string => folder !== undefined && folder !== realpathSync(host.projectDir));

/** A new bench form in the captain's conversation, as /race:bench with nothing after it opens one. */
async function openBenchForm(page: Page) {
  const composer = page.locator(".composer:visible textarea");
  await composer.fill("/race:bench");
  await composer.press("Enter");
  await expect(composer).toHaveValue("/race:bench ");
  await composer.press("Enter");
  await expect(page.locator(".plugin-command-reply:visible")).toContainText("Choose the columns on the canvas, then press Start run.");
  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: "New benchmark run" })).toBeVisible();
  return view;
}

test("/race:bench shows a form whose run checks each racer's work, gives a failed one a second try, and shows the results and totals", async ({ page }) => {
  await helpers().signIn(page, host);
  await helpers().addWorkspace(page, host.projectDir);
  const profiles = await helpers().createProfile(page, profileName, "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: `${profileName} · opencode` });
  captainId = await startConversationWithoutModel(page);
  await sendAndWait(page, "Start");

  const view = await openBenchForm(page);
  await expect(view.locator(".race-head .meta")).toContainText("Tiny · 2 problems");
  await view.getByLabel("Column 1's profile").selectOption(profileName);
  await helpers().untilFramePainted(page, benchFrame(page));
  await view.getByRole("button", { name: "Start run" }).click();

  await expect(view.getByRole("heading", { name: /^Bench run \w+$/ })).toBeVisible();
  const matrix = view.getByRole("table", { name: "Results" });
  await expect(matrix.locator('button[data-cell="0"]'), "answer's racer wrote 42, and its check passed").toContainText("✓", { timeout: 60_000 });
  await expect(matrix.locator('button[data-cell="1"]'), "never's racer failed its check, and its second try too").toContainText("✗ failed", { timeout: 60_000 });
  await expect(matrix.locator("tfoot")).toContainText("1 of 2");
  await expect(view.locator(".race-head .phase")).toHaveText("Done");
  await expect.poll(agentSaw, "the captain heard the summary").toContain("is over", { timeout: 60_000 });
  expect(agentSaw()).toContain("Bench run");

  await matrix.locator('button[data-cell="0"]').click();
  await expect(view.locator(".cell-details")).toContainText("answer · racer");
  await expect(view.locator(".cell-details summary")).toContainText("Try 1: passed in");
  await view.locator(".cell-details").getByRole("button", { name: "Changes" }).click();
  await expect(view.locator(".cell-details").getByLabel("Changes")).toContainText("This racer hasn't changed anything yet.");
});

test("Validate problems shows which problems tell right from wrong", async ({ page }) => {
  rmSync(answerFile(), { force: true });
  mkdirSync(join(host.projectDir, "problems", "never", "reference"), { recursive: true });
  writeFileSync(join(host.projectDir, "problems", "never", "reference", "done.txt"), "done\n");
  git("add", "problems");
  git("commit", "-qm", "never's reference");

  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const view = await openBenchForm(page);
  await helpers().untilFramePainted(page, benchFrame(page));
  await view.getByRole("button", { name: "Validate problems" }).click();

  const validation = view.getByRole("table", { name: "Validation" });
  await expect(validation.locator("tr", { hasText: "answer" }), "answer has no reference solution").toContainText("no reference", { timeout: 60_000 });
  await expect(validation.locator("tr", { hasText: "never" }), "never's check fails on its start and passes with its reference").toContainText("✓ valid", { timeout: 60_000 });
  await expect(view.getByRole("button", { name: "Validate problems" })).toBeEnabled();
});

test("Stop run stops it", async ({ page }) => {
  addProblem("hold", `WRITE [{"waitFor": ${JSON.stringify(join(host.root, "never-made"))}}]`, "test -e done.txt", "start/answer");
  git("add", "problems");
  git("commit", "-qm", "a problem that holds its racer");

  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const view = await openBenchForm(page);
  await view.getByLabel("Column 1's profile").selectOption(profileName);
  await view.getByLabel("Problems").fill("hold");
  await helpers().untilFramePainted(page, benchFrame(page));
  await view.getByRole("button", { name: "Start run" }).click();

  const matrix = view.getByRole("table", { name: "Results" });
  await expect(matrix.locator('button[data-cell="0"]'), "the racer works until the file it waits for exists").toContainText("racing", { timeout: 60_000 });
  await helpers().untilFramePainted(page, benchFrame(page));
  await view.getByRole("button", { name: "Stop run" }).click();
  await expect(matrix.locator('button[data-cell="0"]')).toContainText("stopped");
  await expect(view.locator(".race-head .phase")).toHaveText("Stopped");
  await expect(view.getByRole("button", { name: "Stop run" })).toHaveCount(0);
});

test("The leaderboard shows the set's runs, on the run page and on the form", async ({ page }) => {
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: /^Bench run \w+$/ })).toBeVisible();
  const row = view.getByRole("table", { name: "Leaderboard" }).locator("tbody tr", { hasText: "racer" });
  await expect(row).toHaveCount(1);
  await expect(row.locator("td").nth(1), "the racer took part in both runs").toHaveText("2");
  await expect(row.locator("td").nth(2), "the stopped run passed none of its one problem").toHaveText("0 of 1");
  await expect(row.locator("td").nth(3)).toHaveText("0%");
  await expect(row.locator("td").nth(4), "no earlier run of the same problems").toHaveText("–");

  const form = await openBenchForm(page);
  await expect(form.getByRole("table", { name: "Leaderboard" }).locator("tbody tr", { hasText: "racer" }).locator("td").nth(1)).toHaveText("2");
});

test("A run that deletes its racers keeps each one's changes", async ({ page }) => {
  const goFile = join(host.root, "answer-go");
  addProblem("answer", `WRITE [{"waitFor": ${JSON.stringify(goFile)}}]`, "grep -qx 42 answer.txt");
  git("add", "problems");
  git("commit", "-qm", "answer's racer works in its own folder");

  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const view = await openBenchForm(page);
  await view.getByLabel("Column 1's profile").selectOption(profileName);
  await view.getByLabel("Problems").fill("answer");
  const deleteRacers = view.getByLabel("Delete each racer's conversation and worktree once its result is kept");
  await expect(deleteRacers, "a run of one cell doesn't tick it on its own").not.toBeChecked();
  await deleteRacers.check();
  await helpers().untilFramePainted(page, benchFrame(page));
  const branchesBefore = racerBranches();
  const worktreesBefore = racerWorktrees();
  await view.getByRole("button", { name: "Start run" }).click();

  const heading = view.getByRole("heading", { name: /^Bench run \w+$/ });
  await expect(heading).toBeVisible();
  const runId = (await heading.textContent())!.replace("Bench run ", "");
  const newBranches = () => racerBranches().filter((branch) => !branchesBefore.includes(branch));
  const newWorktrees = () => racerWorktrees().filter((folder) => !worktreesBefore.includes(folder));
  await expect.poll(newWorktrees, "the racer's worktree").toHaveLength(1);
  await expect.poll(newBranches, "the racer's branch").toHaveLength(1);
  const folder = newWorktrees()[0]!;
  const branch = newBranches()[0]!;

  const racerRow = page.locator(".sidebar li[data-reorder-id]", { hasText: `Bench ${runId} · answer · racer` });
  if ((await racerRow.count()) === 0) await page.locator(`.sidebar li[data-reorder-id="${captainId}"] .delegated-toggle`).click();
  await expect(racerRow, "the racer's conversation shows under the captain").toHaveCount(1);

  writeFileSync(join(folder, "answer.txt"), "42\n");
  writeFileSync(goFile, "go\n");

  const matrix = view.getByRole("table", { name: "Results" });
  await expect(matrix.locator('button[data-cell="0"]'), "the racer's answer passed its check").toContainText("✓", { timeout: 60_000 });
  await expect(racerRow, "the racer's conversation leaves the sidebar").toHaveCount(0);
  await expect.poll(() => existsSync(folder), "the racer's worktree folder is gone").toBe(false);
  await expect.poll(() => racerBranches().includes(branch), "the racer's branch is gone from the set's repository").toBe(false);

  await matrix.locator('button[data-cell="0"]').click();
  await view.locator(".cell-details").getByRole("button", { name: "Changes" }).click();
  await expect(view.locator(".cell-details").getByLabel("Changes"), "the cell's Changes still shows the change to answer.txt").toContainText("+42");
});

test("A drafted run of more than 20 racers comes with Delete each racer ticked", async ({ page }) => {
  await helpers().signIn(page, host);
  await page.goto(`${host.origin}/#/c/${captainId}`);
  const columns = Array.from({ length: 6 }, () => ({ profile: profileName }));
  await helpers().callCanvasTool(host, captainId, "bench", { columns, attempts: 5, problems: ["answer", "never"] });

  const view = helpers().walkthroughView(page);
  await expect(view.getByRole("heading", { name: "New benchmark run" })).toBeVisible();
  await expect(view.getByLabel("Column 6's profile")).toBeVisible();
  await expect(view.getByLabel("Delete each racer's conversation and worktree once its result is kept"), "2 problems × 6 columns × 5 attempts is 60 racers").toBeChecked();
});
