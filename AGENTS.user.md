# Team and stages

The roster is `~/.pi/agent/agents/*.md`; teams live in
`~/.pi/agent/agents/teams.yaml` and the active team in
`~/.pi/agent/agents/teams.state.json` (currently `lincx`: scout, spotter,
planner, coder, simplifier, reviewer, issuer). `/agents-team` switches,
`/agents-grid` toggles the widget, `/agents-list` shows the roster.

Every agent run is a fresh-context hop: a headless `pi -p` child carrying the
agent's contract plus `tools:`, `model:` and `thinking:` from its file. Nothing
runs inside this session, so an agent never sees this conversation.

Three ways to start one:

- `agent` tool, by the main agent: `agent({ agent: "scout", task: "…" })`. The
  task must be self-contained; the report comes back as the tool result.
- Typed by hand: `Reviewer: review HEAD` or `Reviewer! review HEAD`. Both start
  the same hop, and the report arrives as a follow-up message.
- From a shell: `pi-hop reviewer "review HEAD"` — answer on stdout, no session.

Routing:

- Unfamiliar code → scout.
- Any change spanning more than one file or more than one step → planner for the
  plan, then coder with the plan.
- Before claiming work is done → reviewer on the diff — fresh eyes, never the
  session that wrote it.
- Small, low-risk issue hunting → spotter. Refactoring or cleanup → simplifier.
- Filing issues/PRs → issuer.

Work directly for quick lookups, single trivial edits, or when I ask you to do
it yourself. Announce the stage you are entering when you switch roles.

The active team gates who may be launched; an agent outside it is refused with
a warning instead of started. `/agents-team` → `all` removes the gate.
