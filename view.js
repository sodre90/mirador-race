/**
 * A race's page: where each racer is and what it changed, the board they share, the vote, and a way to stop the race.
 * Mirador posts the race on every change; Stop goes to the plugin's host code with `mirador.send`.
 */

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font: calc(14px * var(--mirador-font-scale, 1)) var(--mirador-font, system-ui); color: var(--mirador-text); background: var(--mirador-bg); }
  main { padding: 16px 20px; display: grid; gap: 16px; }
  h1 { font-size: 1.15em; margin: 0; }
  h2 { font-size: 1em; margin: 0 0 6px; }
  .meta { color: var(--mirador-muted); }
  .task { white-space: pre-wrap; margin: 6px 0 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--mirador-border); vertical-align: top; }
  th { color: var(--mirador-muted); font-weight: normal; }
  code { font-family: var(--mirador-mono, monospace); font-size: 0.92em; }
  .state-working, .state-starting { color: var(--mirador-accent); }
  .state-finished { color: var(--mirador-ok); }
  .state-failed { color: var(--mirador-danger); }
  .state-stopped { color: var(--mirador-warn); }
  .board { display: grid; gap: 8px; }
  .note { background: var(--mirador-panel); border: 1px solid var(--mirador-border); border-radius: 6px; padding: 6px 10px; }
  .note .who { color: var(--mirador-muted); font-size: 0.9em; }
  .note p { margin: 2px 0 0; white-space: pre-wrap; }
  .empty { color: var(--mirador-faint); }
  button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--mirador-border); background: var(--mirador-panel-2); color: var(--mirador-text); cursor: pointer; }
  .problem { color: var(--mirador-danger); }
`;
document.head.append(style);

const page = document.createElement("main");
document.body.append(page);

const PHASE_WORDS = {
  racing: "Racing",
  voting: "The racers are voting",
  deciding: "Over: the conversation that started it is picking the best work",
  stopped: "Stopped",
};

const el = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
};

const who = (racer) => (racer === 0 ? "Captain" : `Racer ${racer}`);

function racersTable(race) {
  const rows = race.racers.map((racer) =>
    el(
      "tr",
      { "data-racer": String(racer.number) },
      el("td", { text: String(racer.number) }),
      el("td", { class: `state-${racer.state}`, text: racer.state }),
      el("td", { text: racer.changes ?? "–" }),
      el("td", {}, el("code", { text: racer.branch })),
    ),
  );
  const waiting = race.size - race.racers.length;
  if (race.phase === "racing" && waiting > 0) rows.push(el("tr", {}, el("td", { colspan: "4", class: "empty", text: `${waiting} more starting…` })));
  return el("table", { "aria-label": "Racers" }, el("thead", {}, el("tr", {}, ...["Racer", "State", "Changes", "Branch"].map((text) => el("th", { text })))), el("tbody", {}, rows));
}

function board(race) {
  if (race.board.length === 0) return el("p", { class: "empty", text: "Nothing posted yet." });
  return el(
    "div",
    { class: "board", "aria-label": "Board" },
    race.board.map((note) =>
      el("div", { class: "note" }, el("div", { class: "who", text: `${who(note.racer)} · ${new Date(note.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` }), el("p", { text: note.text })),
    ),
  );
}

function vote(race) {
  if (race.voters.length === 0) return null;
  const standings = race.standings
    ? el("ol", { "aria-label": "Standings" }, race.standings.map(({ racer, points }) => el("li", { text: `Racer ${racer}: ${points} ${points === 1 ? "point" : "points"}` })))
    : el("p", { class: "meta", text: `${race.votes.length} of ${race.voters.length} votes in` });
  const reasons = race.votes.map(({ racer, ranking, why }) => el("div", { class: "note" }, el("div", { class: "who", text: `Racer ${racer} ranked ${ranking.join(", ")}` }), el("p", { text: why })));
  return el("section", {}, el("h2", { text: "Vote" }), standings, el("div", { class: "board" }, reasons));
}

function render(race) {
  const problem = el("p", { class: "problem", role: "alert" });
  const stop =
    race.phase === "racing"
      ? el("button", {
          text: "Stop race",
          onclick: () => window.mirador.send({ kind: "stop" }).catch((error) => (problem.textContent = error.message)),
        })
      : null;
  const check = race.check ? el("span", {}, " · check ", el("code", { text: race.check })) : null;
  const sections = [
    el(
      "header",
      {},
      el("h1", { text: `Race ${race.id}` }),
      el("div", { class: "meta" }, `${PHASE_WORDS[race.phase]} · ${race.size} × ${race.profile} · ${race.decide === "vote" ? "racers vote, then the captain picks" : "the captain picks"}`, check),
      el("p", { class: "task", text: race.task }),
    ),
    el("section", {}, racersTable(race), stop, problem),
    el("section", {}, el("h2", { text: "Board" }), board(race)),
    vote(race),
  ];
  page.replaceChildren(...sections.filter(Boolean));
}

window.mirador.onItem((item) => render(item.data));
