import type { CheckResult } from "./race.ts";

export const CHECK_TIMEOUT_MS = 20 * 60_000;
export const CHECK_OUTPUT_LIMIT = 4_000;
/** How long a check has to end after it's told to stop, before it's killed. */
const STOP_GRACE_MS = 5_000;

export interface RunningCheck {
  /** Its shell's pid, which is its process group's too; null for a check that couldn't start. */
  pid: number | null;
  result: Promise<CheckResult>;
  stop(): void;
}

/** Keeps the end of what a check prints, never more than about twice the limit at once. */
class OutputTail {
  private text = "";
  constructor(private readonly limit: number) {}

  add(chunk: string) {
    this.text += chunk;
    if (this.text.length > 2 * this.limit) this.text = this.text.slice(-this.limit);
  }

  get end() {
    return this.text.length <= this.limit ? this.text : `…${this.text.slice(-this.limit)}`;
  }
}

async function readInto(stream: ReadableStream<Uint8Array>, tail: OutputTail) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) tail.add(decoder.decode(chunk, { stream: true }));
  tail.add(decoder.decode());
}

/** Signals the check's whole process group, so the tests and servers it started stop with it. */
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** A check that couldn't start, such as in a folder that's gone, fails with the reason. */
const failedToStart = (error: unknown): RunningCheck => ({
  pid: null,
  result: Promise.resolve({ outcome: "failed", exitCode: null, durationMs: 0, output: error instanceof Error ? error.message : String(error) }),
  stop() {},
});

/**
 * Runs `command` in `folder` in the user's login shell, as Mirador runs a workspace's worktree setup, so it finds the
 * tools the user's shell profile puts on the PATH. What it left running in the background stops when its shell exits,
 * as a server or watcher would otherwise keep its output open and the check from ending. It ends as "timed out" after
 * `timeoutMs`, and `stop` ends it as "stopped"; either way its whole process group gets SIGTERM, then SIGKILL if it's
 * still there `graceMs` on.
 */
export function runCheck(command: string, folder: string, { timeoutMs = CHECK_TIMEOUT_MS, outputLimit = CHECK_OUTPUT_LIMIT, graceMs = STOP_GRACE_MS } = {}): RunningCheck {
  const startedAt = Date.now();
  const tail = new OutputTail(outputLimit);
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([process.env.SHELL || "/bin/sh", "-lc", command], { cwd: folder, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return failedToStart(error);
  }
  let settled = false;
  let endedEarly: "timed out" | "stopped" | null = null;
  const end = (as: "timed out" | "stopped") => {
    if (settled || endedEarly) return;
    endedEarly = as;
    signalGroup(child.pid, "SIGTERM");
    setTimeout(() => signalGroup(child.pid, "SIGKILL"), graceMs).unref();
  };
  const timeout = setTimeout(() => end("timed out"), timeoutMs);
  const result = (async (): Promise<CheckResult> => {
    const [exitCode] = await Promise.all([child.exited.then((code) => (signalGroup(child.pid, "SIGTERM"), code)), readInto(child.stdout, tail), readInto(child.stderr, tail)]);
    settled = true;
    clearTimeout(timeout);
    const durationMs = Date.now() - startedAt;
    if (endedEarly) return { outcome: endedEarly, exitCode: null, durationMs, output: tail.end };
    return { outcome: exitCode === 0 ? "passed" : "failed", exitCode, durationMs, output: tail.end };
  })();
  return { pid: child.pid, result, stop: () => end("stopped") };
}

const isGroupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A process that started this close to when Race started a check on its pid is that check; ps counts whole seconds. */
const SAME_START_SLACK_MS = 3_000;

/** How long `pid` has run, from ps's [[dd-]hh:]mm:ss, or null when no process has it. */
async function secondsRunning(pid: number) {
  const ps = Bun.spawn(["ps", "-o", "etime=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [shown] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  const parts = shown.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!parts) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = parts;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** A check's pid and when it started, which tell it from a process that took its pid since. */
export interface StartedCheck {
  pid: number;
  startedAt: number;
}

/**
 * Ends a check an earlier run of Mirador started, if it still runs: a restart in place leaves it running, and a second
 * run of it in the same folder could fail them both. Its group gets SIGTERM, then SIGKILL if it's still there `graceMs` on.
 */
export async function endLeftover({ pid, startedAt }: StartedCheck, { graceMs = STOP_GRACE_MS } = {}) {
  const running = await secondsRunning(pid);
  if (running === null || Math.abs(Date.now() - running * 1000 - startedAt) > SAME_START_SLACK_MS) return;
  signalGroup(pid, "SIGTERM");
  const giveUpAt = Date.now() + graceMs;
  while (isGroupAlive(pid) && Date.now() < giveUpAt) await Bun.sleep(50);
  signalGroup(pid, "SIGKILL");
}

/**
 * Runs checks a few at a time, as several test suites at once would slow each other down; `stopRace` ends a race's,
 * and its checks asked for later end as stopped at once.
 */
export class CheckQueue {
  private running = 0;
  private readonly waiting: { race: string; run: () => void; drop: () => void }[] = [];
  private readonly started = new Map<string, Set<RunningCheck>>();
  private readonly stoppedRaces = new Set<string>();

  constructor(
    private readonly atOnce: number,
    private readonly start: (command: string, folder: string) => RunningCheck = runCheck,
  ) {}

  /**
   * Resolves to what the check said; one whose race stops before it starts resolves as stopped at once. `started` hears
   * its pid and when it started, as it starts.
   */
  check(race: string, command: string, folder: string, started: (check: StartedCheck) => void = () => {}): Promise<CheckResult> {
    return new Promise((resolve) => {
      const drop = () => resolve({ outcome: "stopped", exitCode: null, durationMs: 0, output: "" });
      if (this.stoppedRaces.has(race)) return drop();
      const run = () => {
        this.running++;
        const check = this.startOrFail(command, folder);
        if (check.pid !== null) started({ pid: check.pid, startedAt: Date.now() });
        const ofRace = this.started.get(race) ?? new Set();
        this.started.set(race, ofRace.add(check));
        check.result.then(resolve).finally(() => {
          ofRace.delete(check);
          this.running--;
          this.next();
        });
      };
      this.waiting.push({ race, run, drop });
      this.next();
    });
  }

  stopRace(race: string) {
    this.stoppedRaces.add(race);
    const dropped = this.waiting.filter((each) => each.race === race);
    this.waiting.splice(0, this.waiting.length, ...this.waiting.filter((each) => each.race !== race));
    dropped.forEach(({ drop }) => drop());
    this.started.get(race)?.forEach((check) => check.stop());
  }

  private startOrFail(command: string, folder: string) {
    try {
      return this.start(command, folder);
    } catch (error) {
      return failedToStart(error);
    }
  }

  private next() {
    while (this.running < this.atOnce && this.waiting.length > 0) this.waiting.shift()!.run();
  }
}
