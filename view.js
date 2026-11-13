/**
 * A race's page: its form before it starts; then a track with a lane for each racer, running from its start through
 * its work and Race's check to the finish, with its time, changes, latest note and check; the board they share; the
 * vote; and, once it's over, a podium of the racers whose work passed and the racers side by side to take one's work.
 * Mirador posts the race on every change; what the page does goes to the plugin's host code with `mirador.send`, and
 * the user's pick to the captain with `mirador.prompt`, as their own message.
 * The same file draws a benchmark run's page: its form before it starts, with the set's problems validated on request;
 * then the problems against the columns, each cell its racer's result, with the totals and a cell's details.
 */

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font: calc(14px * var(--mirador-font-scale, 1)) var(--mirador-font, system-ui); color: var(--mirador-text); background: var(--mirador-bg); }
  main { padding: 18px 20px 28px; display: grid; gap: 20px; }
  h1 { font-size: 1.5em; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 1em; margin: 0 0 10px; }
  .meta { color: var(--mirador-muted); }
  code, pre { font-family: var(--mirador-mono, monospace); font-size: 0.92em; }
  .empty { color: var(--mirador-faint); }
  .problem { color: var(--mirador-danger); margin: 0; }
  .problem:empty { display: none; }
  .picked { color: var(--mirador-ok); }
  details summary { cursor: pointer; }
  pre { margin: 6px 0 0; padding: 8px 10px; background: var(--mirador-bg); border: 1px solid var(--mirador-border); border-radius: 8px; overflow: auto; max-height: 360px; white-space: pre; }
  .diff .added { color: var(--mirador-ok); }
  .diff .removed { color: var(--mirador-danger); }
  .diff .file { color: var(--mirador-accent); }
  button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--mirador-border); background: var(--mirador-panel-2); color: var(--mirador-text); cursor: pointer; }
  button.primary { background: var(--mirador-accent); border-color: var(--mirador-accent); color: var(--mirador-on-accent, white); }
  button.stop { color: var(--mirador-danger); border-color: color-mix(in srgb, var(--mirador-danger) 45%, var(--mirador-border)); }
  button.link { padding: 0; border: 0; background: none; color: var(--mirador-accent); }
  button:disabled { opacity: 0.6; cursor: default; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  label { display: grid; gap: 4px; }
  input[type="text"], textarea, select { font: inherit; color: var(--mirador-text); background: var(--mirador-bg); border: 1px solid var(--mirador-border); border-radius: 6px; padding: 5px 8px; }
  textarea { min-height: 7em; resize: vertical; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--mirador-border); vertical-align: top; }
  th { color: var(--mirador-muted); font-weight: normal; }

  .badge { --size: 26px; flex: none; width: var(--size); height: var(--size); border-radius: 50%; background: var(--racer); color: white; font-weight: 700; font-size: 0.85em; display: inline-grid; place-items: center; }

  .race-head { display: grid; gap: 8px; }
  .title-row { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  .race-clock { font: 600 1.35em var(--mirador-mono, monospace); font-variant-numeric: tabular-nums; color: var(--mirador-muted); }
  .phase { display: inline-flex; align-items: center; gap: 6px; padding: 1px 10px; border-radius: 999px; font-weight: 600; color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); }
  .phase-racing, .phase-voting, .phase-judging, .phase-running { --tone: var(--mirador-accent); }
  .phase-picking, .phase-deciding, .phase-done { --tone: var(--mirador-ok); }
  .phase-stopped { --tone: var(--mirador-warn); }
  .phase-racing::before, .phase-judging::before, .phase-running::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--tone); animation: pulse 1.3s ease-out infinite; }
  @keyframes pulse { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone) 60%, transparent); } to { box-shadow: 0 0 0 9px transparent; } }
  .race-head .meta code { display: inline-block; max-width: 46ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  .task { white-space: pre-wrap; margin: 0; }
  .task.folded { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; color: var(--mirador-muted); }

  .track { border: 1px solid var(--mirador-border); border-radius: 14px; background: var(--mirador-panel); padding: 10px 14px 6px; }
  .lane-row, .lane { display: grid; grid-template-columns: minmax(130px, 190px) 1fr 4.5em; column-gap: 14px; align-items: center; }
  .stages { color: var(--mirador-muted); font-size: 0.72em; letter-spacing: 0.08em; text-transform: uppercase; padding-bottom: 4px; }
  .stages .names { position: relative; height: 1.4em; }
  .stages .names span { position: absolute; transform: translateX(-50%); left: calc(14px + (100% - 42px) * var(--at) / 100); white-space: nowrap; }
  .stages .names span:first-child { left: 0; transform: none; }
  .stages .names span:last-child { left: auto; right: 0; transform: none; }
  .lanes { display: grid; }
  .lane { --racer: var(--mirador-accent); row-gap: 6px; padding: 12px 0; border-top: 1px dashed var(--mirador-border); }
  .lane > .lane-info, .lane > .note, .lane > .checking, .lane > .check, .lane > .diff, .lane > .loading { grid-column: 2 / -1; margin: 0; }
  .lane header { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .lane header div { min-width: 0; }
  .lane h3 { font-size: 1em; margin: 0; }
  .lane header .meta { display: block; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .road { position: relative; height: 32px; border-radius: 16px; background: color-mix(in srgb, var(--mirador-text) 7%, var(--mirador-bg)); overflow: hidden; }
  .road::before { content: ""; position: absolute; left: 14px; right: 28px; top: 50%; border-top: 2px dashed color-mix(in srgb, var(--mirador-text) 16%, transparent); }
  .road .trail { position: absolute; left: 0; top: 0; bottom: 0; width: calc(26px + (100% - 42px) * var(--at) / 100); border-radius: 16px; background: color-mix(in srgb, var(--racer) 22%, transparent); transition: width 1s linear; }
  .road .finish-line { position: absolute; right: 0; top: 0; bottom: 0; width: 14px; opacity: 0.85; background: conic-gradient(#1b1b1b 25%, #f4f4f4 0 50%, #1b1b1b 0 75%, #f4f4f4 0) 0 0 / 8px 8px; }
  .road .car { position: absolute; top: 4px; left: calc(14px + (100% - 42px) * var(--at) / 100); transform: translateX(-50%); width: 24px; height: 24px; border-radius: 50%; background: var(--racer); color: white; font-weight: 700; font-size: 0.8em; display: grid; place-items: center; transition: left 1s linear; }
  .lane.running .trail { background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--racer) 42%, transparent) 0 12px, color-mix(in srgb, var(--racer) 14%, transparent) 12px 24px); animation: stride 0.8s linear infinite; }
  .lane.running .car { box-shadow: 0 0 0 3px color-mix(in srgb, var(--racer) 28%, transparent), 0 0 16px var(--racer); animation: bob 0.45s ease-in-out infinite alternate; }
  .lane.lost .car { background: color-mix(in srgb, var(--racer) 35%, var(--mirador-faint)); }
  .lane.lost .trail { background: color-mix(in srgb, var(--mirador-text) 8%, transparent); }
  .lane.won .trail { background: linear-gradient(90deg, color-mix(in srgb, var(--racer) 15%, transparent), color-mix(in srgb, var(--racer) 45%, transparent)); }
  .lane.won .car { box-shadow: 0 0 0 3px color-mix(in srgb, #e3b341 70%, transparent); }
  @keyframes stride { to { background-position: 24px 0; } }
  @keyframes bob { to { transform: translate(-50%, -2px); } }
  .lane .time { font: 600 1.1em var(--mirador-mono, monospace); font-variant-numeric: tabular-nums; text-align: right; }
  .lane-info { display: flex; gap: 8px 12px; align-items: center; flex-wrap: wrap; }
  .lane .state, .matrix .state { display: inline-flex; align-items: center; gap: 6px; padding: 0 9px; border-radius: 999px; font-size: 0.85em; font-weight: 600; color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); }
  .state-working, .state-starting, .state-checking { --tone: var(--mirador-accent); }
  .state-finished { --tone: var(--mirador-ok); }
  .state-failed { --tone: var(--mirador-danger); }
  .state-stopped { --tone: var(--mirador-warn); }
  .state-working::before, .state-starting::before, .state-checking::before { content: ""; width: 8px; height: 8px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .check-passed { color: var(--mirador-ok); }
  .check-failed, .check-timed-out { color: var(--mirador-danger); }
  .check-stopped { color: var(--mirador-warn); }
  .place { padding: 0 9px; border-radius: 999px; font-size: 0.85em; font-weight: 700; color: color-mix(in srgb, #c8961a 65%, var(--mirador-text)); background: color-mix(in srgb, #e3b341 26%, transparent); }
  .lane .line { color: var(--mirador-muted); overflow-wrap: anywhere; }
  .lane .actions { margin-left: auto; display: flex; gap: 6px; }
  .lane .note { white-space: pre-wrap; max-height: 4.4em; overflow: hidden; padding: 6px 10px; border-radius: 4px 12px 12px 12px; background: color-mix(in srgb, var(--racer) 8%, var(--mirador-bg)); border: 1px solid color-mix(in srgb, var(--racer) 25%, var(--mirador-border)); }
  .lane .checking { color: var(--mirador-accent); }
  .waiting { padding: 10px 0; border-top: 1px dashed var(--mirador-border); }

  .matrix th > span { display: inline-flex; gap: 8px; align-items: center; }
  .matrix .badge { --size: 22px; }
  .matrix button.cell { font: inherit; border: 0; background: none; padding: 2px 9px; border-radius: 999px; text-align: left; }
  .matrix button.cell:hover { background: color-mix(in srgb, var(--mirador-text) 8%, transparent); }
  .matrix button.cell[aria-expanded="true"] { background: color-mix(in srgb, var(--mirador-accent) 14%, transparent); }
  .cell-details { display: grid; gap: 8px; margin-top: 8px; padding: 10px 0 6px; border-top: 1px dashed var(--mirador-border); }

  .podium { display: flex; justify-content: center; align-items: flex-end; gap: 10px; padding-top: 6px; }
  .step { width: 150px; display: grid; justify-items: center; gap: 4px; text-align: center; }
  .step .badge { --size: 40px; font-size: 1.05em; box-shadow: 0 0 0 4px color-mix(in srgb, var(--racer) 22%, transparent); }
  .step .who { font-weight: 600; }
  .step .how { color: var(--mirador-muted); font-size: 0.85em; }
  .step .block { width: 100%; margin-top: 4px; border-radius: 10px 10px 0 0; display: grid; place-items: center; font: 800 1.7em var(--mirador-font, system-ui); color: white; text-shadow: 0 1px 2px rgb(0 0 0 / 25%); }
  .step-1 .block { height: 96px; background: linear-gradient(#f2cd5c, #c8961a); }
  .step-2 .block { height: 68px; background: linear-gradient(#cfd5dc, #98a2ad); }
  .step-3 .block { height: 46px; background: linear-gradient(#d99a62, #a8642c); }
  .step-1 .badge { animation: winner 1.6s ease-in-out infinite alternate; }
  @keyframes winner { to { box-shadow: 0 0 0 6px color-mix(in srgb, #e3b341 45%, transparent), 0 0 22px #e3b341; } }

  .results-section { display: grid; gap: 10px; }
  .results td.racer { white-space: nowrap; }
  .results td.racer > span { display: inline-flex; gap: 8px; align-items: center; }
  .results td.racer .badge { --size: 22px; }
  .results .profile { display: block; color: var(--mirador-muted); white-space: nowrap; }
  .results td.changes { white-space: nowrap; }
  .results .take { display: grid; gap: 6px; justify-items: start; }
  .results .take button, .results .take label { white-space: nowrap; }
  .results .take label { display: flex; gap: 4px; align-items: center; }

  .board { display: grid; gap: 8px; }
  .note-card { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; }
  .note-card .badge { --size: 24px; }
  .note-card .bubble { padding: 6px 10px; border-radius: 4px 12px 12px 12px; background: var(--mirador-panel); border: 1px solid var(--mirador-border); border-left: 3px solid var(--racer); }
  .note-card .who { color: var(--mirador-muted); font-size: 0.85em; }
  .note-card p { margin: 2px 0 0; white-space: pre-wrap; }

  .form { display: grid; gap: 12px; max-width: 760px; }
  .advice { margin: 0; border-left: 3px solid var(--mirador-accent); background: var(--mirador-accent-soft); padding: 6px 10px; border-radius: 6px; }
  .racer-row { display: flex; gap: 8px; align-items: center; }
  .racer-row .badge { --size: 22px; }
  .racer-row > span:not(.badge) { min-width: 5em; color: var(--mirador-muted); }

  .confetti { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 10; }
  .confetti i { position: absolute; top: -16px; border-radius: 2px; }

  @media (max-width: 560px) {
    .lane { grid-template-columns: 1fr auto; }
    .lane > .road { grid-column: 1 / -1; grid-row: 2; }
    .lane > .lane-info, .lane > .note, .lane > .checking, .lane > .check, .lane > .diff, .lane > .loading { grid-column: 1 / -1; }
    .stages { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before { animation: none !important; transition: none !important; }
  }
`;
document.head.append(style);

const page = document.createElement("main");
document.body.append(page);

const MIN_RACERS = 2;
const MAX_RACERS = 6;
const RACER_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ec4899", "#06b6d4", "#8b5cf6"];
const CAPTAIN_COLOR = "#64748b";

/** How fast a working racer's marker moves on: its work has no measure of how far it got, so its time moves it, slower as it goes. */
const WORK_PACE_MS = 5 * 60_000;
const STAGES = [
  ["Start", 0],
  ["Working", 37],
  ["Checking", 80],
  ["Finish", 100],
];

const PHASE_WORDS = {
  racing: "Racing",
  voting: "The racers are voting",
  judging: "The judge is reading their work",
  picking: "Over: pick the work to take",
  deciding: "Over: the conversation that started it is taking the work",
  stopped: "Stopped",
};

const el = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value == null) continue;
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name === "style") node.style.cssText = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (value === true) node.setAttribute(name, "");
    else node.setAttribute(name, value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
};

const who = (racer) => (racer === 0 ? "Captain" : `Racer ${racer}`);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const racerProfile = (race, racer) => racer.profile ?? race.profile ?? "";
const colorOf = (number) => (number === 0 ? CAPTAIN_COLOR : RACER_COLORS[(number - 1) % RACER_COLORS.length]);
const badge = (number) => el("span", { class: "badge", "aria-hidden": "true", style: `--racer: ${colorOf(number)}`, text: number === 0 ? "C" : String(number) });
const ordinal = (place) => ["1st", "2nd", "3rd"][place - 1] ?? `${place}th`;

const clock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};

const seconds = (ms) => {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
};

function checkWords(check) {
  if (check.outcome === "failed") return `Check failed (exit code ${check.exitCode}) in ${seconds(check.durationMs)}`;
  if (check.outcome === "timed out") return `Check ran out of time after ${seconds(check.durationMs)}`;
  if (check.outcome === "stopped") return `Check stopped after ${seconds(check.durationMs)}`;
  return `Check passed in ${seconds(check.durationMs)}`;
}

const workMs = (racer, now = Date.now()) => (racer.endedAt ?? now) - racer.startedAt;

/** Where a racer's marker sits on its lane, from 0 at the start to 100 at the finish. */
function positionOf(racer, now = Date.now()) {
  if (racer.state === "starting") return 0;
  if (racer.state === "checking") return 80;
  if (racer.state === "finished") return 100;
  return Math.round(8 + 56 * (1 - Math.exp(-workMs(racer, now) / WORK_PACE_MS)));
}

/** A racer's time so far: Mirador doesn't post the race every second, so the page counts the running ones itself. */
function timeOf(racer) {
  if (!racer.startedAt) return null;
  return el("span", { class: "time", "data-since": racer.endedAt ? null : String(racer.startedAt), text: clock(workMs(racer)) });
}

setInterval(() => {
  const now = Date.now();
  for (const time of document.querySelectorAll("[data-since]")) time.textContent = clock(now - Number(time.dataset.since));
  for (const road of document.querySelectorAll("[data-working-since]")) road.style.setProperty("--at", String(positionOf({ state: "working", startedAt: Number(road.dataset.workingSince), endedAt: null }, now)));
  for (const cell of document.querySelectorAll("[data-racing-since]")) cell.textContent = cellWords({ state: "working", startedAt: Number(cell.dataset.racingSince) }, now);
}, 1000);

/** What the page holds that the race doesn't: the open patches, the form's answers, and the passes it has cheered. */
const shown = { diffs: new Map(), form: null, profiles: null, combine: new Set(), how: "", resumeAsked: false, taskOpen: false, cheered: null };

function diffView(text) {
  const lines = text.split("\n").map((line) => {
    const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") ? "file" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : null;
    return el("span", { class: kind }, `${line}\n`);
  });
  return el("pre", { class: "diff", "aria-label": "Changes" }, lines);
}

const checkRank = { passed: 0, failed: 1, "timed out": 1, stopped: 2 };

const scoreOf = (race, number) => race.judging?.scores.find(({ racer }) => racer === number)?.score;

/** The finished racers best first: a passing check, then the judge's score, then the vote, then the quicker, then the order they raced. */
function compared(race) {
  const standingOf = (number) => race.standings?.find(({ racer }) => racer === number);
  const place = (racer) => race.standings?.findIndex(({ racer: number }) => number === racer.number) ?? 0;
  return race.racers
    .filter(({ state }) => state === "finished")
    .map((racer) => ({ racer, standing: standingOf(racer.number) }))
    .sort(
      (one, other) =>
        (checkRank[one.racer.check?.outcome] ?? 1) - (checkRank[other.racer.check?.outcome] ?? 1) ||
        (scoreOf(race, other.racer.number) ?? -1) - (scoreOf(race, one.racer.number) ?? -1) ||
        place(one.racer) - place(other.racer) ||
        workMs(one.racer) - workMs(other.racer) ||
        one.racer.number - other.racer.number,
    );
}

/** The racers whose work passed Race's check, or that the judge scored in a race without a check, best first: only such work earns a place. */
const placed = (race) => compared(race).filter(({ racer }) => racer.check?.outcome === "passed" || (!race.check && scoreOf(race, racer.number) !== undefined)).map(({ racer }) => racer);

function laneClass(racer, place) {
  if (["working", "starting", "checking"].includes(racer.state)) return "lane running";
  if (place) return "lane won";
  if (racer.state === "finished" && (!racer.check || racer.check.outcome === "passed")) return "lane";
  return "lane lost";
}

function carMark(racer) {
  if (racer.state === "stopped") return "■";
  if (racer.state === "failed" || ["failed", "timed out"].includes(racer.check?.outcome)) return "✗";
  if (racer.check?.outcome === "passed") return "✓";
  return String(racer.number);
}

function road(racer) {
  return el(
    "div",
    { class: "road", "aria-hidden": "true", style: `--at: ${positionOf(racer)}`, "data-working-since": racer.state === "working" ? String(racer.startedAt) : null },
    el("div", { class: "trail" }),
    el("div", { class: "finish-line" }),
    el("div", { class: "car", text: carMark(racer) }),
  );
}

function lane(race, racer, place, problem) {
  const latest = race.board.findLast((note) => note.racer === racer.number);
  const diff = shown.diffs.get(racer.number);
  const toggleChanges = async () => {
    if (shown.diffs.has(racer.number)) shown.diffs.delete(racer.number);
    else {
      shown.diffs.set(racer.number, "Loading…");
      draw(lastRace);
      try {
        const { diff: text } = await window.mirador.send({ kind: "diff", racer: racer.number });
        shown.diffs.set(racer.number, text);
      } catch (error) {
        shown.diffs.delete(racer.number);
        problem.textContent = error.message;
      }
    }
    draw(lastRace);
  };
  const open = window.mirador.openConversation
    ? el("button", { text: "Open", "data-hint": "Open this racer's conversation", onclick: () => window.mirador.openConversation(racer.conversationId).catch((error) => (problem.textContent = error.message)) })
    : null;
  const check = racer.check
    ? el(
        "details",
        { class: `check check-${racer.check.outcome.replace(" ", "-")}` },
        el("summary", { text: checkWords(racer.check) }),
        racer.check.output ? el("pre", { text: racer.check.output }) : el("p", { class: "empty", text: "It printed nothing." }),
      )
    : racer.state === "checking"
      ? el("div", { class: "checking", text: `Checking: ${race.check}` })
      : null;
  return el(
    "article",
    { class: laneClass(racer, place), "data-racer": String(racer.number), "aria-label": `Racer ${racer.number}`, style: `--racer: ${colorOf(racer.number)}` },
    el("header", {}, badge(racer.number), el("div", {}, el("h3", { text: `Racer ${racer.number}` }), el("span", { class: "meta", text: racerProfile(race, racer) }))),
    road(racer),
    timeOf(racer),
    el(
      "div",
      { class: "lane-info" },
      el("span", { class: `state state-${racer.state}`, text: racer.state }),
      place ? el("span", { class: "place", text: ordinal(place) }) : null,
      el("span", { class: "line" }, `${racer.changes ?? "No changes yet"} · `, el("code", { text: racer.branch })),
      el("span", { class: "actions" }, open, el("button", { text: diff ? "Hide changes" : "Changes", "aria-expanded": diff ? "true" : "false", onclick: toggleChanges })),
    ),
    latest ? el("p", { class: "note", title: latest.text, text: `“${latest.text}”` }) : null,
    check,
    diff ? (diff === "Loading…" ? el("p", { class: "empty loading", text: diff }) : diffView(diff)) : null,
  );
}

function stages() {
  return el(
    "div",
    { class: "stages lane-row", "aria-hidden": "true" },
    el("span"),
    el("div", { class: "names" }, STAGES.map(([name, at]) => el("span", { style: `--at: ${at}`, text: name }))),
    el("span"),
  );
}

function lanes(race, problem) {
  const waiting = race.size - race.racers.length;
  const places = new Map(placed(race).map((racer, index) => [racer.number, index + 1]));
  return el(
    "section",
    { class: "track", "aria-label": "Racers" },
    stages(),
    el(
      "div",
      { class: "lanes" },
      race.racers.map((racer) => lane(race, racer, places.get(racer.number), problem)),
      race.phase === "racing" && waiting > 0 ? el("p", { class: "empty waiting", text: `${waiting} more starting…` }) : null,
    ),
  );
}

function podium(race) {
  if (!["picking", "deciding"].includes(race.phase)) return null;
  const top = placed(race).slice(0, 3);
  if (top.length === 0) return null;
  const step = (racer, place) => {
    const score = scoreOf(race, racer.number);
    return el(
      "div",
      { class: `step step-${place}`, "data-racer": String(racer.number), style: `--racer: ${colorOf(racer.number)}` },
      badge(racer.number),
      el("span", { class: "who", text: `Racer ${racer.number}` }),
      el("span", { class: "how", text: [racerProfile(race, racer), racer.check?.outcome === "passed" ? `✓ ${clock(workMs(racer))}` : clock(workMs(racer)), score !== undefined ? `${score}/10` : null].filter(Boolean).join(" · ") }),
      el("div", { class: "block", text: String(place) }),
    );
  };
  const [first, second, third] = top;
  return el("section", { class: "podium", "aria-label": "Podium" }, second ? step(second, 2) : null, step(first, 1), third ? step(third, 3) : null);
}

/** A burst of confetti over the page, for a check that passed while the user watched. */
function confetti(pieces) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = el("div", { class: "confetti", "aria-hidden": "true" });
  const colors = [...RACER_COLORS, "#e3b341"];
  const bits = Array.from({ length: pieces }, (_, index) => {
    const width = 6 + Math.random() * 5;
    return el("i", { style: `left: ${Math.random() * 100}%; width: ${width}px; height: ${width * 0.6}px; background: ${colors[index % colors.length]}` });
  });
  layer.append(...bits);
  document.body.append(layer);
  bits.forEach((bit) =>
    bit.animate([{ transform: "translate(0, 0) rotate(0)" }, { transform: `translate(${(Math.random() - 0.5) * 160}px, 110vh) rotate(${(Math.random() - 0.5) * 1440}deg)` }], {
      duration: 1800 + Math.random() * 1400,
      delay: Math.random() * 400,
      easing: "cubic-bezier(.2,.6,.4,1)",
      fill: "forwards",
    }),
  );
  setTimeout(() => layer.remove(), 3800);
}

/** Cheers each check that passes while the page shows, the race's first loudest; the ones that passed before it loaded stay quiet. */
function cheer(race) {
  const passed = race.racers.filter((racer) => racer.check?.outcome === "passed").map(({ number }) => number);
  if (shown.cheered) {
    const fresh = passed.filter((number) => !shown.cheered.has(number));
    if (fresh.length > 0) confetti(shown.cheered.size === 0 ? 140 : 50);
  }
  shown.cheered = new Set(passed);
}

function board(race) {
  const notes =
    race.board.length === 0
      ? el("p", { class: "empty", text: "Nothing posted yet." })
      : el(
          "div",
          { class: "board", "aria-label": "Board" },
          race.board.map((note) =>
            el(
              "div",
              { class: "note-card", style: `--racer: ${colorOf(note.racer)}` },
              badge(note.racer),
              el(
                "div",
                { class: "bubble" },
                el("div", { class: "who", text: `${who(note.racer)} · ${new Date(note.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` }),
                el("p", { text: note.text }),
              ),
            ),
          ),
        );
  return el("section", {}, el("h2", { text: "Board" }), notes);
}

const rankingWords = ([first, ...rest]) => `ranked ${first} first${rest.length > 0 ? `, then ${rest.join(", ")}` : ""}`;

/** Two racers that each ranked the other first, the only ranking two can give. */
const eachRankedTheOtherFirst = (race) => race.standings.length === 2 && race.votes.length === 2 && race.standings.every(({ firsts }) => firsts?.length === 1);

function voteWords({ points, firsts = [] }, pointsCount) {
  const parts = [...(pointsCount ? [plural(points, "point", "points")] : []), ...(firsts.length > 0 ? [`ranked first by ${firsts.length === 1 ? "racer" : "racers"} ${firsts.join(", ")}`] : [])];
  return parts.length > 0 ? parts.join(", ") : "ranked first by nobody";
}

const standingWords = (standing, pointsCount) => `Racer ${standing.racer}: ${voteWords(standing, pointsCount)}`;

/** What Race's check said, in a table whose column already says it's the check. */
function shortCheckWords(check) {
  if (check.outcome === "failed") return `Failed (exit code ${check.exitCode}) in ${seconds(check.durationMs)}`;
  if (check.outcome === "timed out") return `Ran out of time after ${seconds(check.durationMs)}`;
  if (check.outcome === "stopped") return `Stopped after ${seconds(check.durationMs)}`;
  return `Passed in ${seconds(check.durationMs)}`;
}

function vote(race) {
  if (race.voters.length === 0) return null;
  const pointsCount = race.standings?.some(({ points }) => points > 0);
  const standings = !race.standings
    ? el("p", { class: "meta", text: `${race.votes.length} of ${race.voters.length} votes in` })
    : eachRankedTheOtherFirst(race)
      ? el("p", { text: "A tie: each ranked the other first." })
      : el("ol", { "aria-label": "Standings" }, race.standings.map((standing) => el("li", { text: standingWords(standing, pointsCount) })));
  const reasons = race.votes.map(({ racer, ranking, why }) =>
    el("div", { class: "note-card", style: `--racer: ${colorOf(racer)}` }, badge(racer), el("div", { class: "bubble" }, el("div", { class: "who", text: `Racer ${racer} ${rankingWords(ranking)}` }), el("p", { text: why }))),
  );
  return el("section", {}, el("h2", { text: "Vote" }), standings, el("div", { class: "board" }, reasons));
}

/** The judge's scores, best first, or why there are none; while it judges, a way to open its conversation or skip it. */
function judge(race) {
  if (!race.judging) return null;
  const { profile, conversationId, scores, summary, missed } = race.judging;
  if (race.phase === "judging") {
    const problem = el("p", { class: "problem", role: "alert" });
    const open =
      conversationId && window.mirador.openConversation
        ? el("button", { text: "Open", "data-hint": "Open the judge's conversation", onclick: () => window.mirador.openConversation(conversationId).catch((error) => (problem.textContent = error.message)) })
        : null;
    return el(
      "section",
      {},
      el("h2", { text: "Judge" }),
      el("p", { text: `${profile} reads each racer's work against the task…` }),
      el("div", { class: "row" }, open, el("button", { class: "stop", text: "Skip the judge", onclick: () => window.mirador.send({ kind: "stop" }).catch((error) => (problem.textContent = error.message)) })),
      problem,
    );
  }
  const body =
    scores.length > 0
      ? [
          el(
            "div",
            { class: "board", "aria-label": "Scores" },
            [...scores]
              .sort((one, other) => other.score - one.score || one.racer - other.racer)
              .map(({ racer, score, why }) =>
                el("div", { class: "note-card", style: `--racer: ${colorOf(racer)}` }, badge(racer), el("div", { class: "bubble" }, el("div", { class: "who", text: `Racer ${racer} · ${score}/10` }), el("p", { text: why }))),
              ),
          ),
          summary ? el("p", { text: summary }) : null,
        ]
      : missed
        ? [el("p", { class: "meta", text: `The judge (${profile}) gave no scores: ${missed}.` })]
        : [];
  return el("section", {}, el("h2", { text: "Judge" }), body);
}

/** The pick goes to the captain, then the race records it; one that went but wasn't recorded keeps its buttons off, so it isn't sent twice. */
async function sendPick(race, pick, problem, buttons) {
  buttons.forEach((button) => (button.disabled = true));
  let sent = false;
  try {
    const { message } = await window.mirador.send({ kind: "pick", pick });
    await window.mirador.prompt(message);
    sent = true;
    await window.mirador.send({ kind: "picked", pick });
    shown.combine.clear();
    shown.how = "";
  } catch (error) {
    problem.textContent = sent ? `Your pick went to the conversation that started the race, but the race page couldn't record it: ${error.message}` : error.message;
    if (!sent) buttons.forEach((button) => (button.disabled = false));
  }
}

function comparison(race) {
  if (!["picking", "deciding"].includes(race.phase)) return null;
  const rows = compared(race);
  if (rows.length === 0) return el("section", {}, el("h2", { text: "Results" }), el("p", { class: "empty", text: "No racer finished its work." }));
  const problem = el("p", { class: "problem", role: "alert" });
  const picks = race.phase === "picking";
  const buttons = [];
  const button = (attributes) => {
    const made = el("button", attributes);
    buttons.push(made);
    return made;
  };
  const columns = ["Racer", "Check", ...(race.judge ? ["Judge"] : []), "Vote", "Changes", ""];
  const table = el(
    "table",
    { class: "results", "aria-label": "Results" },
    el("thead", {}, el("tr", {}, ...columns.map((text) => el("th", { text })))),
    el(
      "tbody",
      {},
      rows.map(({ racer, standing }) => {
        const scored = race.judging?.scores.find(({ racer: number }) => number === racer.number);
        return el(
          "tr",
          { "data-racer": String(racer.number) },
          el("td", { class: "racer" }, el("span", {}, badge(racer.number), el("span", {}, `Racer ${racer.number}`, el("span", { class: "profile", text: racerProfile(race, racer) })))),
          el("td", { class: racer.check ? `check-${racer.check.outcome.replace(" ", "-")}` : "empty", text: racer.check ? shortCheckWords(racer.check) : race.check ? "Not checked" : "No check" }),
          race.judge ? el("td", { class: "judge", title: scored?.why, text: scored ? `${scored.score}/10` : "–" }) : null,
          el("td", { class: "vote", text: standing ? voteWords(standing, race.standings.some(({ points }) => points > 0)) : "–" }),
          el("td", { class: "changes", text: racer.changes ?? "–" }),
          el(
            "td",
            {},
            el(
              "div",
              { class: "take" },
              picks ? button({ text: "Take this", class: "primary", onclick: () => sendPick(race, { kind: "take", racer: racer.number }, problem, buttons) }) : null,
              picks && rows.length > 1
                ? el(
                    "label",
                    {},
                    el("input", {
                      type: "checkbox",
                      checked: shown.combine.has(racer.number),
                      onchange: (event) => (event.target.checked ? shown.combine.add(racer.number) : shown.combine.delete(racer.number)),
                    }),
                    "Combine",
                  )
                : null,
            ),
          ),
        );
      }),
    ),
  );
  const combine =
    picks && rows.length > 1
      ? el(
          "div",
          { class: "row" },
          el("input", { type: "text", "aria-label": "How to combine them", placeholder: "How to combine them, e.g. racer 1's parser with racer 2's tests", value: shown.how, oninput: (event) => (shown.how = event.target.value), style: "flex: 1" }),
          button({ text: "Combine…", onclick: () => sendPick(race, { kind: "combine", racers: [...shown.combine].sort((one, other) => one - other), how: shown.how }, problem, buttons) }),
        )
      : null;
  const footer = picks
    ? el("div", { class: "row" }, button({ text: "Let the captain pick", onclick: () => sendPick(race, { kind: "captain" }, problem, buttons) }))
    : race.picked
      ? el("p", { class: "picked", text: `${race.picked}; the conversation that started the race is on it.` })
      : null;
  return el("section", { class: "results-section" }, el("h2", { text: picks ? "Pick the work to take" : "Results" }), table, combine, footer, problem);
}

/** How long the race has run: live while it races, else until its last racer's work and check ended. */
function raceClock(race) {
  if (race.phase === "racing") return el("span", { class: "race-clock", "data-since": String(race.startedAt), text: clock(Date.now() - race.startedAt) });
  const ends = race.racers.map((racer) => (racer.endedAt ?? racer.startedAt) + (racer.check?.durationMs ?? 0));
  return ends.length > 0 ? el("span", { class: "race-clock", text: clock(Math.max(...ends) - race.startedAt) }) : null;
}

const LONG_TASK = 280;

function task(race) {
  const long = race.task.length > LONG_TASK || race.task.split("\n").length > 3;
  const folded = long && !shown.taskOpen;
  const toggle = long
    ? el("button", {
        class: "link",
        text: folded ? "Show the whole task" : "Fold the task",
        "aria-expanded": folded ? "false" : "true",
        onclick: () => {
          shown.taskOpen = !shown.taskOpen;
          draw(lastRace);
        },
      })
    : null;
  return [el("p", { class: folded ? "task folded" : "task", text: race.task }), toggle ? el("div", {}, toggle) : null];
}

function header(race) {
  const profiles = [...new Set(race.racers.map((racer) => racerProfile(race, racer)))].filter(Boolean);
  const check = race.check ? el("span", {}, " · check ", el("code", { title: race.check, text: race.check })) : null;
  const hidden = race.checkFiles ? el("span", { title: race.checkFiles, text: " · with hidden check files" }) : null;
  const decide = race.decide === "vote" ? "racers vote first" : "no vote";
  return el(
    "header",
    { class: "race-head" },
    el("div", { class: "title-row" }, el("h1", { text: `Race ${race.id}` }), raceClock(race)),
    el(
      "div",
      { class: "meta" },
      el("span", { class: `phase phase-${race.phase}`, text: PHASE_WORDS[race.phase] ?? race.phase }),
      ` · ${plural(race.size, "racer", "racers")} on ${profiles.join(", ") || "…"} · ${decide}${race.judge ? ` · judged by ${race.judge}` : ""}`,
      check,
      hidden,
    ),
    task(race),
  );
}

function raceView(race) {
  cheer(race);
  const problem = el("p", { class: "problem", role: "alert" });
  const stop =
    race.phase === "racing"
      ? el("button", { class: "stop", text: "Stop race", onclick: () => window.mirador.send({ kind: "stop" }).catch((error) => (problem.textContent = error.message)) })
      : null;
  return [header(race), podium(race), comparison(race), lanes(race, problem), el("div", { class: "row" }, stop, problem), board(race), vote(race), judge(race)];
}

/** The form's answers, from the race's draft the first time, then as the user changes them. */
function formOf(race) {
  if (!shown.form) {
    const size = race.size ?? 4;
    shown.form = {
      task: race.task ?? "",
      profiles: Array.from({ length: size }, (_, index) => race.profiles?.[index % Math.max(1, race.profiles.length)] ?? ""),
      check: race.check ?? "",
      checkFiles: race.checkFiles ?? "",
      vote: race.decide === "vote",
      judge: race.judge ?? "",
    };
  }
  return shown.form;
}

function loadProfiles(race) {
  if (shown.profiles) return;
  shown.profiles = [];
  window.mirador.send({ kind: "profiles" }).then(
    (profiles) => {
      shown.profiles = profiles;
      const form = formOf(race);
      form.profiles = form.profiles.map((name) => profiles.find((profile) => profile.name.toLowerCase() === name.toLowerCase())?.name ?? profiles[0]?.name ?? "");
      form.judge = profiles.find((profile) => profile.name.toLowerCase() === form.judge.toLowerCase())?.name ?? "";
      draw(lastRace);
    },
    (error) => console.error("race: the profiles could not be listed:", error),
  );
}

/** A profile as the form offers it: its name, the model it sets, else its agent, and the effort it sets: "Work · Opus 5.5 · high". */
const profileLabel = ({ name, agent, model, effort }) => [name, model?.name ?? agent, effort].filter(Boolean).join(" · ");

function formView(race) {
  loadProfiles(race);
  const form = formOf(race);
  const problem = el("p", { class: "problem", role: "alert" });
  const options = (chosen) => shown.profiles.map((profile) => el("option", { value: profile.name, selected: profile.name === chosen, text: profileLabel(profile) }));
  const racerRows = form.profiles.map((profile, index) =>
    el(
      "div",
      { class: "racer-row" },
      badge(index + 1),
      el("span", { text: `Racer ${index + 1}` }),
      el("select", { "aria-label": `Racer ${index + 1}'s profile`, onchange: (event) => (form.profiles[index] = event.target.value) }, options(profile)),
      form.profiles.length > MIN_RACERS
        ? el("button", {
            text: "Remove",
            "aria-label": `Remove racer ${index + 1}`,
            onclick: () => {
              form.profiles.splice(index, 1);
              draw(lastRace);
            },
          })
        : null,
    ),
  );
  const start = el("button", {
    class: "primary",
    text: "Start race",
    onclick: async () => {
      start.disabled = true;
      problem.textContent = "";
      try {
        await window.mirador.send({ kind: "start", task: form.task, profiles: form.profiles, check: form.check, checkFiles: form.checkFiles, decide: form.vote ? "vote" : "captain", judge: form.judge || undefined });
      } catch (error) {
        problem.textContent = error.message;
        start.disabled = false;
      }
    },
  });
  return [
    el("header", { class: "race-head" }, el("h1", { text: "New race" }), el("p", { class: "meta", text: "Several agents work on the task at once, each in a git worktree of its own. When they're done, you pick the work to take." })),
    el(
      "div",
      { class: "form" },
      el("label", {}, "Task", el("textarea", { "aria-label": "Task", placeholder: "Everything the racers need: what to do, which files, how to tell it works", oninput: (event) => (form.task = event.target.value) }, form.task)),
      el(
        "div",
        { class: "form", role: "group", "aria-label": "Racers" },
        el("strong", { text: "Racers" }),
        racerRows,
        form.profiles.length < MAX_RACERS
          ? el(
              "div",
              {},
              el("button", {
                text: "Add a racer",
                onclick: () => {
                  form.profiles.push(form.profiles.at(-1) ?? shown.profiles[0]?.name ?? "");
                  draw(lastRace);
                },
              }),
            )
          : null,
      ),
      race.advice ? el("p", { class: "advice", role: "note", text: `The captain advises: ${race.advice}` }) : null,
      el("label", {}, "Check (optional)", el("input", { type: "text", "aria-label": "Check", placeholder: "e.g. bun test", value: form.check, oninput: (event) => (form.check = event.target.value) })),
      el("label", {}, "Hidden check files (optional)", el("input", { type: "text", "aria-label": "Hidden check files", placeholder: "A folder the racers never get, e.g. /tmp/race-checks: copied over each racer's work before the check", value: form.checkFiles, oninput: (event) => (form.checkFiles = event.target.value) })),
      el("label", { class: "row" }, el("input", { type: "checkbox", checked: form.vote, onchange: (event) => (form.vote = event.target.checked) }), "The racers rank each other's work before I pick"),
      el(
        "label",
        {},
        "Judge (optional)",
        el("select", { "aria-label": "Judge", onchange: (event) => (form.judge = event.target.value) }, el("option", { value: "", selected: form.judge === "", text: "No judge" }), options(form.judge)),
      ),
      el("div", { class: "row" }, start, problem),
    ),
  ];
}

let lastRace = null;

/** A race still racing when the page loads may have been cut short by a restart of Mirador, which reloads the page; Race carries it on. */
function resumeRace(race) {
  if (shown.resumeAsked || race.phase !== "racing") return;
  shown.resumeAsked = true;
  window.mirador.send({ kind: "resume" }).catch((error) => console.error("race: the race could not go on after a restart:", error));
}

function draw(race) {
  lastRace = race;
  resumeRace(race);
  const sections = race.phase === "setup" ? formView(race) : raceView(race);
  page.replaceChildren(...sections.flat().filter(Boolean));
}

/** What the bench page holds that the run doesn't: the form's answers, the set and profiles it asked for, the open cell and its patch. */
const shownBench = { form: null, set: null, profiles: null, open: null, diffs: new Map(), resumeAsked: false };

const MAX_COLUMNS = 6;
const MAX_ATTEMPTS = 5;
const MAX_AT_ONCE = 6;

const BENCH_PHASE_WORDS = { running: "Running", done: "Done", stopped: "Stopped" };

/** bench.ts's words for a run, copied word for word as the view can't import them; its seconds() is benchSeconds here, the race's own wording durations differently. */
const columnLabel = ({ profile, model, effort }) => [profile, model, effort].filter(Boolean).join(" · ");

function benchSeconds(ms) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} m ${String(total % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

function cellWords(cell, now) {
  const { state, result, startedAt, endedAt } = cell;
  if (state === "working") return `racing ${benchSeconds(now - startedAt)}`;
  if (state === "retrying") return "try 2";
  if (state !== "done") return state;
  const took = benchSeconds(endedAt - startedAt);
  if (result === "passed") return `✓ ${took}`;
  if (result === "passed on try 2") return `✓ on try 2 · ${took}`;
  if (result === "failed" || result === "timed out" || result === "agent failed") return `✗ ${result}`;
  return result;
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((one, other) => one - other);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const summedCost = (cells) => {
  const costs = cells.flatMap(({ usage }) => (usage?.cost ? [usage.cost] : []));
  const [first] = costs;
  if (!first || costs.some(({ currency }) => currency !== first.currency)) return null;
  return { amount: costs.reduce((sum, { amount }) => sum + amount, 0), currency: first.currency };
};

function totalsOf(run) {
  return run.columns.map((_, column) => {
    const cells = run.cells.filter((cell) => cell.column === column);
    const done = cells.filter(({ result }) => result !== null);
    const passed = done.filter(({ result }) => result === "passed" || result === "passed on try 2");
    const durations = done
      .filter(({ startedAt, endedAt }) => startedAt !== null && endedAt !== null)
      .map(({ startedAt, endedAt }) => (endedAt - startedAt) / 1000);
    return {
      column,
      done: done.length,
      passedFirstTry: done.filter(({ result }) => result === "passed").length,
      passed: passed.length,
      problemsSolved: new Set(passed.map(({ problem }) => problem)).size,
      medianSeconds: median(durations),
      inputTokens: cells.reduce((sum, { usage }) => sum + (usage?.inputTokens ?? 0), 0),
      outputTokens: cells.reduce((sum, { usage }) => sum + (usage?.outputTokens ?? 0), 0),
      cost: summedCost(cells),
    };
  });
}

const tokenWords = (count) => (count < 1000 ? String(count) : `${Math.round(count / 1000)}k`);
const costWords = ({ amount, currency }) => (currency === "USD" ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`);

const passedWords = ({ passed, done, passedFirstTry }) => {
  const onTry2 = passed - passedFirstTry;
  return `${passed} of ${done} · ${done > 0 ? Math.round((passed / done) * 100) : 0}%${onTry2 > 0 ? ` · ${onTry2} on try 2` : ""}`;
};

const cellClass = (cell) => {
  if (cell.state !== "done") return cell.state === "waiting" ? "empty" : "state state-working";
  if (cell.result === "passed" || cell.result === "passed on try 2") return "check-passed";
  if (cell.result === "stopped") return "check-stopped";
  if (cell.result === "couldn't start") return "empty";
  return "check-failed";
};

function loadBenchSet(run) {
  if (shownBench.set) return;
  shownBench.set = { name: run.set.name, problems: null, problemsLeftOut: [] };
  window.mirador.send({ kind: "set" }).then(
    (set) => {
      shownBench.set = set;
      drawBench(lastBench);
    },
    (error) => console.error("bench: the set could not be read:", error),
  );
}

function loadBenchProfiles(run) {
  if (shownBench.profiles) return;
  shownBench.profiles = [];
  window.mirador.send({ kind: "profiles" }).then(
    (profiles) => {
      shownBench.profiles = profiles;
      const form = benchFormOf(run);
      form.columns.forEach((column) => (column.profile = profiles.find((profile) => profile.name.toLowerCase() === column.profile.toLowerCase())?.name ?? profiles[0]?.name ?? ""));
      drawBench(lastBench);
    },
    (error) => console.error("bench: the profiles could not be listed:", error),
  );
}

/** The form's answers, from the run's draft the first time, then as the user changes them. */
function benchFormOf(run) {
  if (!shownBench.form) {
    shownBench.form = {
      columns: run.columns.length > 0 ? run.columns.map(({ profile, model, effort }) => ({ profile, model: model ?? "", effort: effort ?? "" })) : [{ profile: "", model: "", effort: "" }],
      attempts: run.attempts,
      atOnce: run.atOnce,
      tries: run.settings.tries === 2,
      deleteRacers: null,
      problems: run.problems.join(", "),
      validating: false,
      error: "",
    };
  }
  return shownBench.form;
}

/** Whether the form deletes its racers until the user says otherwise: what the run asked, or a run of more than 20 cells, counting All as the set's problems. */
function deleteRacersByDefault(run, form, set) {
  const named = form.problems.split(",").map((id) => id.trim()).filter(Boolean);
  const problems = named.length > 0 ? named.length : (set.problems?.length ?? 0);
  return run.deleteRacers || problems * form.columns.length * form.attempts > 20;
}

/** Each problem's validation, as the host finds them: ✓ valid, or the words in the danger color, with the output folded. */
function validationTable(run) {
  if (!run.validation) return null;
  return el(
    "table",
    { "aria-label": "Validation" },
    el(
      "tbody",
      {},
      run.validation.map(({ problem, validation, output }) => {
        const verdict = validation === "valid" ? "✓ valid" : validation;
        return el(
          "tr",
          {},
          el("td", { text: problem }),
          el("td", { class: validation === "valid" ? "check-passed" : "check-failed" }, output ? el("details", {}, el("summary", { text: verdict }), el("pre", { text: output })) : verdict),
        );
      }),
    ),
  );
}

function benchFormView(run) {
  loadBenchSet(run);
  loadBenchProfiles(run);
  const form = benchFormOf(run);
  const set = shownBench.set;
  if (form.validating && set.problems && (run.validation?.length ?? 0) >= set.problems.length) form.validating = false;
  const problem = el("p", { class: "problem", role: "alert", text: form.error });
  const options = (chosen) => shownBench.profiles.map((profile) => el("option", { value: profile.name, selected: profile.name === chosen, text: profileLabel(profile) }));
  const columnRows = form.columns.map((column, index) =>
    el(
      "div",
      { class: "racer-row" },
      badge(index + 1),
      el("span", { text: `Column ${index + 1}` }),
      el("select", { "aria-label": `Column ${index + 1}'s profile`, onchange: (event) => (column.profile = event.target.value) }, options(column.profile)),
      el("input", { type: "text", "aria-label": `Column ${index + 1}'s model`, placeholder: "Model (optional)", value: column.model, style: "flex: 1; min-width: 7em", oninput: (event) => (column.model = event.target.value) }),
      el("input", { type: "text", "aria-label": `Column ${index + 1}'s effort`, placeholder: "Effort (optional)", value: column.effort, style: "flex: 1; min-width: 7em", oninput: (event) => (column.effort = event.target.value) }),
      form.columns.length > 1
        ? el("button", {
            text: "Remove",
            "aria-label": `Remove column ${index + 1}`,
            onclick: () => {
              form.columns.splice(index, 1);
              drawBench(lastBench);
            },
          })
        : null,
    ),
  );
  const validate = el("button", {
    text: form.validating ? "Validating…" : "Validate problems",
    disabled: form.validating,
    onclick: async () => {
      form.validating = true;
      form.error = "";
      drawBench(lastBench);
      try {
        await window.mirador.send({ kind: "validate" });
        drawBench(lastBench);
      } catch (error) {
        form.validating = false;
        form.error = error.message;
        drawBench(lastBench);
      }
    },
  });
  const start = el("button", {
    class: "primary",
    text: "Start run",
    onclick: async () => {
      start.disabled = true;
      form.error = "";
      problem.textContent = "";
      try {
        const problems = form.problems.split(",").map((id) => id.trim()).filter(Boolean);
        await window.mirador.send({
          kind: "start",
          columns: form.columns.map(({ profile, model, effort }) => ({ profile, ...(model ? { model } : {}), ...(effort ? { effort } : {}) })),
          attempts: form.attempts,
          tries: form.tries ? 2 : 1,
          atOnce: form.atOnce,
          deleteRacers: form.deleteRacers ?? deleteRacersByDefault(run, form, set),
          ...(problems.length > 0 ? { problems } : {}),
        });
      } catch (error) {
        form.error = error.message;
        problem.textContent = error.message;
        start.disabled = false;
      }
    },
  });
  return [
    el(
      "header",
      { class: "race-head" },
      el("h1", { text: "New benchmark run" }),
      el("p", { class: "meta", text: [set.name, set.problems ? plural(set.problems.length, "problem", "problems") : null].filter(Boolean).join(" · ") }),
    ),
    set.problemsLeftOut.length > 0
      ? el("div", {}, el("strong", { text: "Problems left out" }), el("ul", {}, set.problemsLeftOut.map(({ id, why }) => el("li", { text: `${id}: ${why}` }))))
      : null,
    el(
      "div",
      { class: "form" },
      el(
        "div",
        { class: "form", role: "group", "aria-label": "Columns" },
        el("strong", { text: "Columns" }),
        columnRows,
        form.columns.length < MAX_COLUMNS
          ? el(
              "div",
              {},
              el("button", {
                text: "Add a column",
                onclick: () => {
                  form.columns.push({ profile: form.columns.at(-1)?.profile ?? shownBench.profiles[0]?.name ?? "", model: "", effort: "" });
                  drawBench(lastBench);
                },
              }),
            )
          : null,
      ),
      el("label", {}, "Attempts", el("input", { type: "number", "aria-label": "Attempts", min: 1, max: MAX_ATTEMPTS, value: form.attempts, oninput: (event) => (form.attempts = Number(event.target.value)) })),
      el("label", {}, "Racers at once per profile", el("input", { type: "number", "aria-label": "Racers at once per profile", min: 1, max: MAX_AT_ONCE, value: form.atOnce, oninput: (event) => (form.atOnce = Number(event.target.value)) })),
      el("label", { class: "row" }, el("input", { type: "checkbox", checked: form.tries, onchange: (event) => (form.tries = event.target.checked) }), "A second try after a failed check"),
      el("label", { class: "row" }, el("input", { type: "checkbox", checked: form.deleteRacers ?? deleteRacersByDefault(run, form, set), onchange: (event) => (form.deleteRacers = event.target.checked) }), "Delete each racer's conversation and worktree once its result is kept"),
      el("label", {}, "Problems", el("input", { type: "text", "aria-label": "Problems", placeholder: "All; or ids, separated by commas", value: form.problems, oninput: (event) => (form.problems = event.target.value) })),
      el("div", {}, validate),
      validationTable(run),
      el("div", { class: "row" }, start, problem),
    ),
  ];
}

function benchHeader(run) {
  return el(
    "header",
    { class: "race-head" },
    el("div", { class: "title-row" }, el("h1", { text: `Bench run ${run.id}` })),
    el(
      "div",
      { class: "meta" },
      `${run.set.name} · ${run.set.commit ? run.set.commit.slice(0, 7) : "…"} · `,
      el("span", { class: `phase phase-${run.phase}`, text: BENCH_PHASE_WORDS[run.phase] ?? run.phase }),
      ` · ${plural(run.problems.length, "problem", "problems")} × ${plural(run.columns.length, "column", "columns")}`,
    ),
  );
}

function cellButton(cell, index) {
  return el("button", {
    class: `cell ${cellClass(cell)}`,
    "data-cell": String(index),
    "data-racing-since": cell.state === "working" ? String(cell.startedAt) : null,
    "aria-expanded": shownBench.open === index ? "true" : "false",
    text: cellWords(cell, Date.now()),
    onclick: () => {
      shownBench.open = shownBench.open === index ? null : index;
      drawBench(lastBench);
    },
  });
}

/** The problems against the columns, one row per problem and attempt, with each column's totals under them. */
function benchMatrix(run) {
  const rows = [];
  run.cells.forEach((cell, index) => {
    const last = rows.at(-1);
    if (last && last.problem === cell.problem && last.attempt === cell.attempt) last.cells.push({ cell, index });
    else rows.push({ problem: cell.problem, attempt: cell.attempt, cells: [{ cell, index }] });
  });
  const totals = totalsOf(run);
  return el(
    "table",
    { class: "matrix", "aria-label": "Results" },
    el(
      "thead",
      {},
      el("tr", {}, el("th", { text: "Problem" }), run.columns.map((column, index) => el("th", {}, el("span", {}, badge(index + 1), columnLabel(column))))),
    ),
    el(
      "tbody",
      {},
      rows.map((row) =>
        el(
          "tr",
          {},
          el("th", { scope: "row", text: run.attempts > 1 ? `${row.problem} · attempt ${row.attempt}` : row.problem }),
          row.cells.map(({ cell, index }) => el("td", {}, cellButton(cell, index))),
        ),
      ),
    ),
    el(
      "tfoot",
      {},
      el("tr", {}, el("th", { scope: "row", text: "Passed" }), totals.map((total) => el("td", { text: passedWords(total) }))),
      el("tr", {}, el("th", { scope: "row", text: "Median time" }), totals.map((total) => el("td", { text: total.medianSeconds === null ? "–" : benchSeconds(total.medianSeconds * 1000) }))),
      el("tr", {}, el("th", { scope: "row", text: "Tokens" }), totals.map((total) => el("td", { text: `${tokenWords(total.inputTokens + total.outputTokens)}${total.cost ? ` · ${costWords(total.cost)}` : ""}` }))),
    ),
  );
}

/** The open cell's racer: its conversation, changes, tries, usage and note. */
function cellDetails(run, problem) {
  const index = shownBench.open;
  const cell = index === null ? null : run.cells[index];
  if (!cell) return null;
  const column = run.columns[cell.column];
  const diff = shownBench.diffs.get(index);
  const toggleChanges = async () => {
    if (shownBench.diffs.has(index)) shownBench.diffs.delete(index);
    else {
      shownBench.diffs.set(index, "Loading…");
      drawBench(lastBench);
      try {
        const { diff: text } = await window.mirador.send({ kind: "diff", cell: index });
        shownBench.diffs.set(index, text);
      } catch (error) {
        shownBench.diffs.delete(index);
        problem.textContent = error.message;
      }
    }
    drawBench(lastBench);
  };
  const open =
    cell.conversationId && window.mirador.openConversation
      ? el("button", { text: "Open", "data-hint": "Open this racer's conversation", onclick: () => window.mirador.openConversation(cell.conversationId).catch((error) => (problem.textContent = error.message)) })
      : null;
  return el(
    "div",
    { class: "cell-details" },
    el("h2", { text: [cell.problem, columnLabel(column), run.attempts > 1 ? `attempt ${cell.attempt}` : null].filter(Boolean).join(" · ") }),
    el("div", { class: "row" }, open, el("button", { text: diff ? "Hide changes" : "Changes", "aria-expanded": diff ? "true" : "false", onclick: toggleChanges })),
    cell.tries.map(({ check }, number) =>
      el(
        "details",
        { class: `check check-${check.outcome.replace(" ", "-")}` },
        el("summary", { text: `Try ${number + 1}: ${check.outcome} in ${benchSeconds(check.durationMs)}` }),
        check.output ? el("pre", { text: check.output }) : el("p", { class: "empty", text: "It printed nothing." }),
      ),
    ),
    cell.usage ? el("p", { class: "meta", text: `${tokenWords(cell.usage.inputTokens)} in · ${tokenWords(cell.usage.outputTokens)} out${cell.usage.cost ? ` · ${costWords(cell.usage.cost)}` : ""}` }) : null,
    cell.ranOn ? el("p", { class: "meta", text: `Ran on ${cell.ranOn.model.name}${cell.ranOn.effort ? ` · ${cell.ranOn.effort}` : ""}` }) : null,
    cell.note ? el("p", { text: cell.note }) : null,
    diff ? (diff === "Loading…" ? el("p", { class: "empty loading", text: diff }) : diffView(diff)) : null,
  );
}

/** Cheers each cell that passes while the page shows; the ones that passed before it loaded stay quiet. */
function benchCheer(run) {
  const passed = (cell) => cell?.result === "passed" || cell?.result === "passed on try 2";
  if (!lastBench || !run.cells.some((cell, index) => passed(cell) && !passed(lastBench.cells[index]))) return;
  confetti(lastBench.cells.some(passed) ? 50 : 140);
}

function benchRunView(run) {
  benchCheer(run);
  const problem = el("p", { class: "problem", role: "alert" });
  const stop =
    run.phase === "running"
      ? el("button", { class: "stop", text: "Stop run", onclick: () => window.mirador.send({ kind: "stop" }).catch((error) => (problem.textContent = error.message)) })
      : null;
  return [benchHeader(run), el("section", { class: "track" }, benchMatrix(run), cellDetails(run, problem)), el("div", { class: "row" }, stop, problem)];
}

let lastBench = null;

/** A run already running when the page loads may have been cut short by a restart of Mirador, which reloads the page; the run carries on. A run this page watched start needs no resume: its cells are starting, not cut short. */
function resumeBench(run) {
  if (shownBench.resumeAsked || run.phase !== "running" || lastBench !== null) return;
  shownBench.resumeAsked = true;
  window.mirador.send({ kind: "resume" }).catch((error) => console.error("bench: the run could not go on after a restart:", error));
}

function drawBench(run) {
  resumeBench(run);
  const sections = run.phase === "setup" ? benchFormView(run) : benchRunView(run);
  page.replaceChildren(...sections.flat().filter(Boolean));
  lastBench = run;
}

window.mirador.onItem((item) => {
  if (item.type === "bench") {
    if (lastBench?.phase === "setup" && item.data.phase !== "setup") shownBench.form = null;
    drawBench(item.data);
    return;
  }
  if (lastRace?.phase === "setup" && item.data.phase !== "setup") shown.form = null;
  draw(item.data);
});
