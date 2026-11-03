# Changelog

## [1.1.0] - 2026-11-04

- `agent` tool: the main agent can dispatch to a roster specialist and gets the
  report back as the tool result. One run at a time; the task must be
  self-contained because the child starts with an empty context.
- Live hop status: the child's `--mode json` stream is folded while it runs, so
  cards show the running model plus live `↓`/`↑` tokens, and tool progress
  reports the same numbers.
- Both hand-typed prefixes (`Agent:` and `Agent!`) now start a hop; nothing runs
  in the parent session any more.
- `typebox` added to the host peer dependencies; details shape unified across
  progress and final tool results.

## [1.0.0] - 2026-11-04

Initial release.

- `agents-grid.ts`: standalone roster, team switching, grid widget, in-session
  addressing (`Agent: task`) and fresh-context hops (`Agent! task`).
- Seven agent contracts (`scout`, `spotter`, `planner`, `coder`, `simplifier`,
  `reviewer`, `issuer`) with per-agent `tools`, `model` and `thinking`.
- `pi-hop`: run any agent as a one-shot headless hop from a shell, git hook or CI.
- Optional `AGENTS.md` user policy describing the sequential pipeline.
