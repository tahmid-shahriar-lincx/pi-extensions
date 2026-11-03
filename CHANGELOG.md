# Changelog

## [1.0.0] - 2026-11-04

Initial release.

- `agents-grid.ts`: standalone roster, team switching, grid widget, in-session
  addressing (`Agent: task`) and fresh-context hops (`Agent! task`).
- Seven agent contracts (`scout`, `spotter`, `planner`, `coder`, `simplifier`,
  `reviewer`, `issuer`) with per-agent `tools`, `model` and `thinking`.
- `pi-hop`: run any agent as a one-shot headless hop from a shell, git hook or CI.
- Optional `AGENTS.md` user policy describing the sequential pipeline.
