# Changelog

## Unreleased

- All seven contracts carry a `Read Discipline` block: locate with `grep -n` and
  read by range, read a file end to end only when changing it, cap command
  output at the source, and stay out of `node_modules`, `.git`, `dist`,
  `build`, `coverage` and `vendor`. Orientation reads were the largest cost in
  a hop.
- README: the opening example no longer claims in-session runs, and the roster
  precedence now lists every scanned source in the order the extension
  resolves it (closes #1).

## [1.2.0] - 2026-11-04

- Cards are a single line: status icon, name, then elapsed time and live `↓`/`↑`
  tokens while a hop runs. Descriptions no longer have a caption line; they are
  in `/agents-list`, along with the model, which is also on each report line.
- The grid fills a row with as many cards as fit (22-column minimum), so a wide
  terminal shows the whole team on one line.
- No widget padding and no in-widget header: the widget is only the cards, and
  the team/count/active text is the status line it already set.
- `Main` card: the parent session now appears first in the grid and in
  `/agents-list`, so a running turn is visible the same way a running hop is.
  It tracks `agent_start` → `agent_settled` and is not an addressable agent.

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
