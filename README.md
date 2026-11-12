# Race

A [Mirador](https://github.com/sodre90/mirador) plugin that races a task on several agents of one profile at once, such as four of a small local model, and has them work as a team: each works in a git worktree and branch of its own, and they share a board where they post what they learn. When all have finished, the conversation that started the race picks the best work, or combines the best parts, and merges it.

- `race({ task, profile, racers, check, decide })` starts the racers, 4 unless you name another number (2 to 6), and returns at once. Each racer gets the task, then how to race: read the board first, post its plan, peek at the others' work and borrow what helps, run the check, commit on its branch, post a last note.
- `race_board({ post })` reads the notes the others posted since the racer last read, and where each racer stands, and posts a note. The conversation that started the race can post too, to steer them.
- `race_peek({ racer })` shows a racer's work since the race began as a diff, committed or not, new files included, without touching that racer's staging.
- `check` is a command, such as the project's tests, that each racer runs before it finishes. The plugin never runs it itself: the racers and the captain run it through their own shells, so Mirador's permissions still ask.
- With `decide: "vote"`, the finished racers first rank each other's work with `race_vote`, and the standings (Borda count) go to the captain with their reasons. A racer that ends its turn without voting abstains.
- Once every racer has finished, been stopped or failed, the conversation that started the race hears it as its next message: each racer's branch, folder, changes and last words, the vote if there was one, and what to do next: run the check in each folder, pick or combine the work, merge it, and tell you why.
- The race page shows the racers, what each changed, the board and the vote, with **Stop race**, which stops the racers still working and asks nobody to decide.

Racers branch from the workspace's last commit, so work the main checkout hasn't committed isn't in their folders. A new worktree has no installed dependencies either: set the workspace's **Setup command for a new worktree** under *Where conversations work*, such as `bun install`, so each racer's check can run.

Needs Mirador's plugin API 12, which lets a plugin start a conversation in a git worktree of its own. The workspace must be in a git repository with a commit.

## Develop

```bash
bun install
bun run typecheck
bun run test     # unit tests
scripts/e2e.sh   # e2e in a Mirador test host from MIRADOR_DIR, with Mirador's Playwright
```

`MIRADOR_DIR` is Mirador's checkout, by default `../visualized-claude-sessions`.
