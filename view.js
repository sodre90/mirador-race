/**
 * A race's page: its form before it starts; then a lane for each racer with where it is, what it changed, its latest
 * note and Race's check; the board they share; the vote; and, once it's over, the racers side by side to take one's work.
 * Mirador posts the race on every change; what the page does goes to the plugin's host code with `mirador.send`, and the
 * user's pick to the captain with `mirador.prompt`, as their own message.
 */

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font: calc(14px * var(--mirador-font-scale, 1)) var(--mirador-font, system-ui); color: var(--mirador-text); background: var(--mirador-bg); }
  main { padding: 16px 20px; display: grid; gap: 18px; }
  h1 { font-size: 1.15em; margin: 0; }
  h2 { font-size: 1em; margin: 0 0 8px; }
  .meta { color: var(--mirador-muted); }
  .task { white-space: pre-wrap; margin: 6px 0 0; }
  code, pre { font-family: var(--mirador-mono, monospace); font-size: 0.92em; }
  .lanes { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .lane { border: 1px solid var(--mirador-border); border-radius: 8px; padding: 10px 12px; display: grid; gap: 6px; align-content: start; background: var(--mirador-panel); }
  .lane header { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .lane h3 { font-size: 1em; margin: 0; }
  .lane .actions { margin-left: auto; display: flex; gap: 6px; }
  .lane .line { color: var(--mirador-muted); overflow-wrap: anywhere; }
  .lane .note { margin: 0; white-space: pre-wrap; max-height: 6.5em; overflow: hidden; }
  .state-working, .state-starting, .state-checking { color: var(--mirador-accent); }
  .state-finished, .check-passed { color: var(--mirador-ok); }
  .state-failed, .check-failed, .check-timed-out { color: var(--mirador-danger); }
  .state-stopped, .check-stopped { color: var(--mirador-warn); }
  details summary { cursor: pointer; }
  pre { margin: 4px 0 0; padding: 6px 8px; background: var(--mirador-bg); border: 1px solid var(--mirador-border); border-radius: 6px; overflow: auto; max-height: 360px; white-space: pre; }
  .diff .added { color: var(--mirador-ok); }
  .diff .removed { color: var(--mirador-danger); }
  .diff .file { color: var(--mirador-accent); }
  .board { display: grid; gap: 8px; }
  .note-card { background: var(--mirador-panel); border: 1px solid var(--mirador-border); border-radius: 6px; padding: 6px 10px; }
  .note-card .who { color: var(--mirador-muted); font-size: 0.9em; }
  .note-card p { margin: 2px 0 0; white-space: pre-wrap; }
  .empty { color: var(--mirador-faint); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--mirador-border); vertical-align: top; }
  th { color: var(--mirador-muted); font-weight: normal; }
  button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--mirador-border); background: var(--mirador-panel-2); color: var(--mirador-text); cursor: pointer; }
  button.primary { background: var(--mirador-accent); border-color: var(--mirador-accent); color: var(--mirador-on-accent, white); }
  button:disabled { opacity: 0.6; cursor: default; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  label { display: grid; gap: 4px; }
  input[type="text"], textarea, select { font: inherit; color: var(--mirador-text); background: var(--mirador-bg); border: 1px solid var(--mirador-border); border-radius: 6px; padding: 5px 8px; }
  textarea { min-height: 7em; resize: vertical; }
  .form { display: grid; gap: 12px; max-width: 760px; }
  .racer-row { display: flex; gap: 8px; align-items: center; }
  .racer-row span { min-width: 5em; color: var(--mirador-muted); }
  .problem { color: var(--mirador-danger); }
  .picked { color: var(--mirador-ok); }
  .results .profile { display: block; color: var(--mirador-muted); white-space: nowrap; }
  .results td.changes { white-space: nowrap; }
  .results .take { display: grid; gap: 6px; justify-items: start; }
  .results .take button, .results .take label { white-space: nowrap; }
  .results .take label { display: flex; gap: 4px; align-items: center; }
`;
document.head.append(style);

const page = document.createElement("main");
document.body.append(page);

const MIN_RACERS = 2;
const MAX_RACERS = 6;

const PHASE_WORDS = {
  racing: "Racing",
  voting: "The racers are voting",
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

/** A racer's time so far: Mirador doesn't post the race every second, so the page counts the running ones itself. */
function timeOf(racer) {
  if (!racer.startedAt) return null;
  return el("span", { class: "time", "data-since": racer.endedAt ? null : String(racer.startedAt), text: clock((racer.endedAt ?? Date.now()) - racer.startedAt) });
}

setInterval(() => {
  for (const time of document.querySelectorAll("[data-since]")) time.textContent = clock(Date.now() - Number(time.dataset.since));
}, 1000);

/** What the page holds that the race doesn't: the open patches, and the form's answers. */
const shown = { diffs: new Map(), form: null, profiles: null, combine: new Set(), how: "" };

function diffView(text) {
  const lines = text.split("\n").map((line) => {
    const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") ? "file" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : null;
    return el("span", { class: kind }, `${line}\n`);
  });
  return el("pre", { class: "diff", "aria-label": "Changes" }, lines);
}

function lane(race, racer, problem) {
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
      ? el("div", { class: "state-checking", text: `Checking: ${race.check}` })
      : null;
  return el(
    "article",
    { class: "lane", "data-racer": String(racer.number), "aria-label": `Racer ${racer.number}` },
    el(
      "header",
      {},
      el("h3", { text: `Racer ${racer.number}` }),
      el("span", { class: "meta", text: racerProfile(race, racer) }),
      el("span", { class: `state state-${racer.state}`, text: racer.state }),
      timeOf(racer),
      el("span", { class: "actions" }, open, el("button", { text: diff ? "Hide changes" : "Changes", "aria-expanded": diff ? "true" : "false", onclick: toggleChanges })),
    ),
    el("div", { class: "line" }, `${racer.changes ?? "No changes yet"} · `, el("code", { text: racer.branch })),
    latest ? el("p", { class: "note", title: latest.text, text: `“${latest.text}”` }) : null,
    check,
    diff ? (diff === "Loading…" ? el("p", { class: "empty", text: diff }) : diffView(diff)) : null,
  );
}

function lanes(race, problem) {
  const waiting = race.size - race.racers.length;
  return el(
    "section",
    { "aria-label": "Racers" },
    el("div", { class: "lanes" }, race.racers.map((racer) => lane(race, racer, problem)), race.phase === "racing" && waiting > 0 ? el("p", { class: "empty", text: `${waiting} more starting…` }) : null),
  );
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
              { class: "note-card" },
              el("div", { class: "who", text: `${who(note.racer)} · ${new Date(note.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` }),
              el("p", { text: note.text }),
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
  const reasons = race.votes.map(({ racer, ranking, why }) => el("div", { class: "note-card" }, el("div", { class: "who", text: `Racer ${racer} ${rankingWords(ranking)}` }), el("p", { text: why })));
  return el("section", {}, el("h2", { text: "Vote" }), standings, el("div", { class: "board" }, reasons));
}

const checkRank = { passed: 0, failed: 1, "timed out": 1, stopped: 2 };

/** The finished racers best first: a passing check, then the vote, then the order they raced. */
function compared(race) {
  const standingOf = (number) => race.standings?.find(({ racer }) => racer === number);
  const place = (racer) => race.standings?.findIndex(({ racer: number }) => number === racer.number) ?? 0;
  return race.racers
    .filter(({ state }) => state === "finished")
    .map((racer) => ({ racer, standing: standingOf(racer.number) }))
    .sort((one, other) => (checkRank[one.racer.check?.outcome] ?? 1) - (checkRank[other.racer.check?.outcome] ?? 1) || place(one.racer) - place(other.racer) || one.racer.number - other.racer.number);
}

async function sendPick(race, pick, problem, buttons) {
  buttons.forEach((button) => (button.disabled = true));
  try {
    const { message } = await window.mirador.send({ kind: "pick", pick });
    await window.mirador.prompt(message);
    shown.combine.clear();
    shown.how = "";
  } catch (error) {
    problem.textContent = error.message;
    buttons.forEach((button) => (button.disabled = false));
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
  const table = el(
    "table",
    { class: "results", "aria-label": "Results" },
    el("thead", {}, el("tr", {}, ...["Racer", "Check", "Vote", "Changes", ""].map((text) => el("th", { text })))),
    el(
      "tbody",
      {},
      rows.map(({ racer, standing }) =>
        el(
          "tr",
          { "data-racer": String(racer.number) },
          el("td", {}, `Racer ${racer.number}`, el("span", { class: "profile", text: racerProfile(race, racer) })),
          el("td", { class: racer.check ? `check-${racer.check.outcome.replace(" ", "-")}` : "empty", text: racer.check ? shortCheckWords(racer.check) : race.check ? "Not checked" : "No check" }),
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
        ),
      ),
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
  return el("section", {}, el("h2", { text: picks ? "Pick the work to take" : "Results" }), table, combine, footer, problem);
}

function header(race) {
  const profiles = [...new Set(race.racers.map((racer) => racerProfile(race, racer)))].filter(Boolean);
  const check = race.check ? el("span", {}, " · check ", el("code", { text: race.check })) : null;
  const decide = race.decide === "vote" ? "racers vote first" : "no vote";
  return el(
    "header",
    {},
    el("h1", { text: `Race ${race.id}` }),
    el("div", { class: "meta" }, `${PHASE_WORDS[race.phase] ?? race.phase} · ${plural(race.size, "racer", "racers")} on ${profiles.join(", ") || "…"} · ${decide}`, check),
    el("p", { class: "task", text: race.task }),
  );
}

function raceView(race) {
  const problem = el("p", { class: "problem", role: "alert" });
  const stop =
    race.phase === "racing"
      ? el("button", { text: "Stop race", onclick: () => window.mirador.send({ kind: "stop" }).catch((error) => (problem.textContent = error.message)) })
      : null;
  return [header(race), comparison(race), lanes(race, problem), el("div", { class: "row" }, stop, problem), board(race), vote(race)];
}

/** The form's answers, from the race's draft the first time, then as the user changes them. */
function formOf(race) {
  if (!shown.form) {
    const size = race.size ?? 4;
    shown.form = {
      task: race.task ?? "",
      profiles: Array.from({ length: size }, (_, index) => race.profiles?.[index % Math.max(1, race.profiles.length)] ?? ""),
      check: race.check ?? "",
      vote: race.decide === "vote",
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
      draw(lastRace);
    },
    (error) => console.error("race: the profiles could not be listed:", error),
  );
}

function formView(race) {
  loadProfiles(race);
  const form = formOf(race);
  const problem = el("p", { class: "problem", role: "alert" });
  const options = (chosen) => shown.profiles.map(({ name, agent }) => el("option", { value: name, selected: name === chosen, text: `${name} · ${agent}` }));
  const racerRows = form.profiles.map((profile, index) =>
    el(
      "div",
      { class: "racer-row" },
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
        await window.mirador.send({ kind: "start", task: form.task, profiles: form.profiles, check: form.check, decide: form.vote ? "vote" : "captain" });
      } catch (error) {
        problem.textContent = error.message;
        start.disabled = false;
      }
    },
  });
  return [
    el("header", {}, el("h1", { text: "New race" }), el("p", { class: "meta", text: "Several agents work on the task at once, each in a git worktree of its own. When they're done, you pick the work to take." })),
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
          ? el("div", {}, el("button", {
              text: "Add a racer",
              onclick: () => {
                form.profiles.push(form.profiles.at(-1) ?? shown.profiles[0]?.name ?? "");
                draw(lastRace);
              },
            }))
          : null,
      ),
      el("label", {}, "Check (optional)", el("input", { type: "text", "aria-label": "Check", placeholder: "e.g. bun test", value: form.check, oninput: (event) => (form.check = event.target.value) })),
      el("label", { class: "row" }, el("input", { type: "checkbox", checked: form.vote, onchange: (event) => (form.vote = event.target.checked) }), "The racers rank each other's work before I pick"),
      el("div", { class: "row" }, start, problem),
    ),
  ];
}

let lastRace = null;

function draw(race) {
  lastRace = race;
  const sections = race.phase === "setup" ? formView(race) : raceView(race);
  page.replaceChildren(...sections.filter(Boolean));
}

window.mirador.onItem((item) => {
  if (lastRace?.phase === "setup" && item.data.phase !== "setup") shown.form = null;
  draw(item.data);
});
