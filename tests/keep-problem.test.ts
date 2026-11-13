import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeMirador as fakeMiradorIn, finished, git } from "./fake-mirador.ts";

let scratch: string;
let repo: string;
let set: string;

const fakeMirador = () => fakeMiradorIn({ repo, scratch });

const CHECK_SH = "grep -qx 42 answer.txt\n";

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "keep-problem-test-")));
  repo = join(scratch, "project");
  await mkdir(repo);
  await git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
  await git(repo, ["config", "user.name", "t"]);
  await git(repo, ["config", "user.email", "t@t"]);
  writeFileSync(join(repo, "app.ts"), "export const answer = 1;\n");
  writeFileSync(join(repo, "answer.txt"), "0\n");
  await mkdir(join(repo, "tests"));
  writeFileSync(join(repo, "tests", "test.sh"), CHECK_SH);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "base"]);
  set = join(scratch, "set");
  await mkdir(set);
  await git(set, ["-c", "init.defaultBranch=main", "init", "-q"]);
  await git(set, ["config", "user.name", "t"]);
  await git(set, ["config", "user.email", "t@t"]);
  writeFileSync(join(set, "set.json"), JSON.stringify({ name: "Kept", tries: 1, checkTimeoutMinutes: 1 }));
  await git(set, ["add", "-A"]);
  await git(set, ["commit", "-qm", "set"]);
});
afterEach(() => rm(scratch, { recursive: true, force: true }));

/** A race over and waiting for the pick: racer 1 made the answer 42 and passed the check, racer 2 left it and failed. */
async function racedOver() {
  const mirador = fakeMirador();
  await mirador.call(mirador.captain, "race", { task: "Make the answer 42", profile: "Qwen Flash", racers: 2, check: "sh tests/test.sh" });
  writeFileSync(join(mirador.started[0]!.folder, "answer.txt"), "42\n");
  await mirador.replied(1, finished("Changed answer.txt; the check passes."));
  await mirador.replied(2, finished("done"));
  return mirador;
}

const keep = (mirador: ReturnType<typeof fakeMirador>, asked: { id?: string; racer?: number; checkFiles?: string[]; check?: string; setFolder?: string } = {}) =>
  mirador.act({ kind: "keep-problem", setFolder: asked.setFolder ?? set, id: asked.id ?? "answer", racer: asked.racer ?? 1, checkFiles: asked.checkFiles ?? ["tests/test.sh"], check: asked.check ?? "sh tests/test.sh" });

test("keeping a race with a passing racer and a test file makes a problem that validates as valid", async () => {
  const mirador = await racedOver();
  expect(mirador.page().phase).toBe("picking");
  expect(mirador.page().racers[0]!.check!.outcome).toBe("passed");

  const result = (await keep(mirador)) as { kept: string; validation: { problem: string; validation: string } };

  expect(result.kept).toBe("answer");
  expect(result.validation).toMatchObject({ problem: "answer", validation: "valid" });
  expect(JSON.parse(readFileSync(join(set, "problems", "answer", "problem.json"), "utf8"))).toEqual({ start: "start/answer", check: "sh tests/test.sh", tags: ["kept"] });
  expect(readFileSync(join(set, "problems", "answer", "task.md"), "utf8")).toBe("Make the answer 42");
  expect(readFileSync(join(set, "problems", "answer", "check", "tests", "test.sh"), "utf8")).toBe(CHECK_SH);
  expect(readFileSync(join(set, "problems", "answer", "reference", "answer.txt"), "utf8")).toBe("42\n");
  expect(mirador.captain.storage.get("lastSetFolder")).toBe(set);
  expect(await mirador.act({ kind: "keepDefault" })).toEqual({ setFolder: set });
});

test("its start branch has the base's files but not the check file, and the racer's index and files stay as they were", async () => {
  const mirador = await racedOver();
  const folder = mirador.started[0]!.folder;
  const statusBefore = await git(folder, ["status", "--porcelain"]);

  await keep(mirador);

  const files = (await git(set, ["ls-tree", "-r", "--name-only", "start/answer"])).trim().split("\n").sort();
  expect(files).toEqual(["answer.txt", "app.ts"]);
  expect(await git(set, ["show", "start/answer:answer.txt"])).toBe("0\n");
  expect(await git(folder, ["status", "--porcelain"])).toBe(statusBefore);
  expect(readFileSync(join(folder, "tests", "test.sh"), "utf8")).toBe(CHECK_SH);
});

test("ids with dots and underscores are kept, as a set loads them", async () => {
  const mirador = await racedOver();

  for (const id of ["django__django-11099", "fix-1.2"]) {
    const result = (await keep(mirador, { id })) as { kept: string; validation: { problem: string; validation: string } };
    expect(result).toMatchObject({ kept: id, validation: { problem: id, validation: "valid" } });
  }
});

test("a taken id, a bad id, a folder that isn't a set, a missing check file, an empty check and a deleted racer are refused, each saying why", async () => {
  const mirador = await racedOver();
  await keep(mirador);

  const idRule = "A problem's id is lower case letters, digits, dots, dashes or underscores, starting with a letter or digit.";
  await expect(keep(mirador)).rejects.toThrow("The set has a problem answer already.");
  await expect(keep(mirador, { id: "Bad Id" })).rejects.toThrow(idRule);
  await expect(keep(mirador, { id: "-lead" })).rejects.toThrow(idRule);
  await expect(keep(mirador, { id: "a/b" })).rejects.toThrow(idRule);
  const plain = join(scratch, "plain");
  await mkdir(plain);
  await expect(keep(mirador, { id: "other", setFolder: plain })).rejects.toThrow("isn't a problem set");
  await expect(keep(mirador, { id: "other", checkFiles: ["nope.sh"] })).rejects.toThrow("Racer 1's folder has no nope.sh.");
  await expect(keep(mirador, { id: "other", check: "   " })).rejects.toThrow("Give the check command.");

  await mirador.act({ kind: "pick", pick: { kind: "take", racer: 1 } });
  await mirador.act({ kind: "picked", pick: { kind: "take", racer: 1 } });
  await mirador.captainHeard({ kind: "turn-ended", ended: "finished" });
  await mirador.act({ kind: "deleteRacers" });
  await expect(keep(mirador, { id: "gone" })).rejects.toThrow("Racer 1 was deleted, so its folder is gone.");
});

test("a keep that fails partway leaves no half-written problem, so trying again isn't refused as taken", async () => {
  const mirador = await racedOver();
  const key = `race:${mirador.page().id}`;
  const kept = mirador.captain.storage.get(key) as { race: { base: string | null } };
  const base = kept.race.base;
  mirador.captain.storage.set(key, { ...kept, race: { ...kept.race, base: "0".repeat(40) } });

  await expect(keep(mirador)).rejects.toThrow("bad object");
  expect(existsSync(join(set, "problems", "answer"))).toBe(false);

  mirador.captain.storage.set(key, { ...kept, race: { ...kept.race, base } });
  expect(await keep(mirador)).toMatchObject({ kept: "answer", validation: { validation: "valid" } });
});

test("a problem kept with no check files still loads, and its start branch keeps the base's files", async () => {
  const mirador = await racedOver();

  const result = (await keep(mirador, { id: "bare", checkFiles: [], check: "grep -qx 42 answer.txt" })) as { kept: string; validation: { validation: string } };

  expect(result.kept).toBe("bare");
  expect(result.validation.validation).toBe("valid");
  const files = (await git(set, ["ls-tree", "-r", "--name-only", "start/bare"])).trim().split("\n").sort();
  expect(files).toEqual(["answer.txt", "app.ts", "tests/test.sh"]);
});
