# Race

A [Mirador](https://github.com/sodre90/mirador) plugin that races a task on several agents at once, on one profile, such as four of a small local model, or on one of several profiles each, to compare them, and has them work as a team: each works in a git worktree and branch of its own, and they share a board where they post what they learn. Only you start a race: an agent's call fills in the race's form for you to check and start. When all have finished, you take the best work, or combine the best parts, from the race page, or let the conversation that started the race pick and merge it.

![Four racers at work under the conversation that started the race, each in a lane on the race page](screenshots/racers-beside-captain.png)

- `race({ task, profile, profiles, racers, check, decide })`, called by an agent, only drafts the race: it puts the race's form on the canvas, filled in with what the agent asked, and nothing runs until you check it and press **Start race**. It refuses a draft without a task, or one naming a profile Mirador doesn't have; with no profile named, you choose them on the form. The racers run on `profile`, or on `profiles` in turn, one racer each when several are named; there are `racers` of them (2 to 6), else 4. Each racer gets the task, then how to race: read the board first, post its plan, peek at the others' work and borrow what helps, run the check, commit on its branch, post a last note.
- `/race:race` with nothing after it opens a form on the canvas: the task, a profile for each racer, the check, and whether the racers vote. `/race:race task=… profile=…` starts the race at once. Every race waits for your pick.
- `race_board({ post })` reads the notes the others posted since the racer last read, and where each racer stands, and posts a note. The conversation that started the race can post too, to steer them.
- `race_peek({ racer })` shows a racer's work since the race began as a diff, committed or not, new files included, without touching that racer's staging.
- `check` is a command, such as the project's tests, that each racer runs before it finishes. Race also runs it itself in each racer's folder once that racer is done, in your login shell, two at a time, for up to 20 minutes, keeping the end of what it printed; **Stop race** stops it. That includes a check an agent drafted, once you press **Start race**, so read it on the form first.
- With `decide: "vote"`, the finished racers first rank each other's work with `race_vote`, hearing what Race's check said. Each ranking gives a racer a point for each racer ranked below it, so abstaining takes nothing from anyone; two racers that each rank the other first are a tie, and the page and the captain hear who ranked whom first and why.
- Once every racer has finished, been stopped or failed, the conversation that started the race hears it as its next message: each racer's profile, branch, folder, changes, check and last words, and the vote if there was one. It only says the race waits for your pick, and the page offers **Take this** for each racer, **Combine…** for the ones you tick, with how, and **Let the captain pick**, which go to it as your message.
- The race page is a track: each racer runs on a lane of its own colour from the start, through its work and Race's check, to a checkered finish, with its profile, state and time, what it changed, its latest note and Race's check with its output, **Open** for its conversation and **Changes** for its work inline. A long task shows folded. Below are the board, each note beside its racer's colour, and the vote. Once it's over, a podium shows the racers whose work passed Race's check, best first: by the vote, then the quicker. Only work that passed earns a place, and a check that passes while you watch gets a burst of confetti.

![The race form: the task, a profile for each racer, the check and the vote](screenshots/race-form.png)

![Each racer's lane, one with its changes open](screenshots/race-under-way.png)

![Picking the work to take: each racer's check and vote side by side](screenshots/pick-the-work.png)

Racers branch from the workspace's last commit, so work the main checkout hasn't committed isn't in their folders. A new worktree has no installed dependencies either: set the workspace's **Setup command for a new worktree** under *Where conversations work*, such as `bun install`, so each racer's check can run.

Needs Mirador's plugin API 13, which lets a plugin's page start conversations, open them and list the profiles. The workspace must be in a git repository with a commit.

## Develop

```bash
bun install
bun run typecheck
bun run test     # unit tests
scripts/e2e.sh   # e2e in a Mirador test host from MIRADOR_DIR, with Mirador's Playwright
MIRADOR_SCREENSHOTS=1 scripts/e2e.sh e2e/screenshots.spec.ts   # retakes the pictures in screenshots/
```

`MIRADOR_DIR` is Mirador's checkout, by default `../visualized-claude-sessions`.
