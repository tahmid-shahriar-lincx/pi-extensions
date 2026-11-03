# pi-extensions

A sequential agent team for [Pi](https://pi.dev): a roster grid, seven agent
contracts, per-agent model/tool routing, and fresh-context hops. No `subagent`
tool, no orchestration framework — you route, it executes.

```
Scout: map the auth token flow                    ← hop: fresh context
Planner: plan the retry cap using those findings  ← hop: fresh context
Coder: implement the plan                         ← hop: fresh context
Reviewer! git diff                                ← hop: fresh context
Issuer: file the follow-up we spotted             ← hop: fresh context
```

Each of those lines starts its own run with a fresh context and returns a
report as a follow-up. Nothing runs in the session you typed in.

## Install

```sh
pi install git:github.com/tahmid-shahriar-lincx/pi-extensions@v1.2.0
bash ~/.pi/agent/git/github.com/tahmid-shahriar-lincx/pi-extensions/install.sh   # adds pi-hop
```

Restart Pi, then `/agents-list` and `/agents-grid 3`.

`install.sh` only links `bin/pi-hop` into `~/.local/bin`. Add `--with-policy`
if you also want this repo's `AGENTS.user.md` linked as `~/.pi/agent/AGENTS.md`
(backed up first). The extension and the agents need no linking: Pi clones the
series into `~/.pi/agent/git/<host>/<owner>/<repo>` and the extension scans the
`agents/` directory sitting next to it.

Update:

```sh
pi update --extensions     # reconcile the configured ref
```

Pinned refs (`@v1.0.0`) stay put until you change the ref. Use `@main` to track
the branch instead, at the cost of unpinned surprises.

### Without the package (dotfiles style)

```sh
git clone git@github.com:tahmid-shahriar-lincx/pi-extensions.git ~/src/pi-extensions
cp ~/src/pi-extensions/extensions/agents-grid.ts ~/.pi/agent/extensions/
cp ~/src/pi-extensions/agents/*.md ~/.pi/agent/agents/
bash ~/src/pi-extensions/install.sh
```

Copying the `.md` files into `~/.pi/agent/agents/` makes them *user* agents,
which outrank package agents — useful when you want to fork a contract locally.

## Usage

Every run is a fresh-context hop: a headless `pi -p` child with that agent's
contract, tools, model and thinking. Nothing runs inside the current session.

| You type | What happens |
|---|---|
| `agent({ agent: "reviewer", task: "…" })` | the main agent dispatches a hop; the report is the tool result |
| `Reviewer: check the auth change` | same hop, started by hand; answer arrives as a follow-up |
| `Reviewer! check the auth change` | identical — `!` is kept for muscle memory |
| `Approacher: size this up` | alias → `planner` |
| `/agents-list` | roster with model, thinking, tools, source |
| `/agents-grid 3` | pin 3 columns (`1`-`6`, `off`, `on`) |
| `/agents-team` | switch team; `all` removes the gate |
| `/agents-hop reviewer review HEAD` | hop without typing a prefix |
| `/agents-stop` | SIGTERM running hops |

Cards are one line — status icon, agent name, and (while a hop runs) elapsed
time plus live `↓`/`↑` tokens folded from the child's `--mode json` stream.
`Main` is prepended to every view: it is the session you are talking to, so a
running parent turn (`● Main 12s`) is as visible as a running hop. It is not an
agent — it cannot be addressed, dispatched or team-gated. There
is no caption line and no widget padding: the widget is only the cards, and the
team/count/active text is the status line. Rows fill with as many cards as fit
(22-column minimum), so a 200-column terminal shows seven agents on one line.
Descriptions and models live in `/agents-list`; the model is also on each hop's
report line, and the tool result carries the token numbers in its details.

From any shell:

```sh
pi-hop reviewer "review HEAD vs origin/main"      # answer on stdout
pi-hop coder "add the retry cap from docs/retry.md"
```

Hops get `--tools`, `--model` and `--thinking` from the agent's frontmatter, so
routing lives in the contract, not in your settings file.

## Agents

| Agent | Role | Model | Tools |
|---|---|---|---|
| `scout` | read-only recon | deepseek-flash | read, grep, find, ls |
| `spotter` | find small, well-scoped issues | deepseek-flash | read, grep, find, ls, bash |
| `planner` | plan doc: goals, 3 approaches, estimate | deepseek-flash | read, write, bash, grep, find, ls |
| `coder` | implement, minimal diffs | deepseek-flash | read, write, edit, bash, grep, find, ls |
| `simplifier` | refactor down, behavior unchanged | deepseek-flash | read, write, edit, bash, grep, find, ls |
| `reviewer` | severity-led review, reports only | glm-5.3 (high) | read, bash, grep, find, ls |
| `issuer` | file issues / open PRs | deepseek-flash | read, grep, find, ls, bash |

Every contract also carries a `## Read Discipline` block — find with `grep -n`
and read by range, read a file end to end only when changing it, cap command
output at the source, and stay out of `node_modules`, `.git`, `dist`, `build`,
`coverage` and `vendor`. Orientation reads were the biggest cost in a hop.

Edit an agent by editing its markdown. **Frontmatter** carries identity and
routing (`name`, `description`, `aliases`, `tools`, `model`, `thinking`); the
**body** is the contract. Body edits apply on the next message; frontmatter
edits on the next 30-second roster refresh.

## Layout

```
agents/            seven contracts + teams.yaml (the team definition)
extensions/        agents-grid.ts — roster, teams, hops (no dependencies)
bin/pi-hop         one-hop CLI for shells, hooks and CI
AGENTS.user.md     optional user policy describing the pipeline
install.sh         links pi-hop (and optionally AGENTS.user.md)
```

## Precedence

Roster (first match wins, flat scan): `agents/` in the cwd → `.claude/agents/`
in the cwd → `.pi/agents/` in the cwd → `~/.pi/agent/agents/` → this package's
`agents/`. A name found earlier wins; a project directory therefore overrides
your user agents and the package defaults. Teams: this package's `teams.yaml` →
user `~/.pi/agent/agents/teams.yaml` → project `.pi/agents/teams.yaml`.

A named team is a gate: addressing an agent outside it is refused with a
warning instead of launched. `teams.state.json` (which team you last picked) is
per machine and deliberately git-ignored.

## Requirements

Pi ≥ 1.5.0. The extension registers an `agent` tool, so Pi must supply
`typebox` (it does) and the extension needs the host peer packages listed in
`package.json`. Hops shell out to the `pi` binary on `PATH` (override with
`PI_HOP_BIN`), cap at 3 concurrent runs, run one at a time, and time out after
20 minutes (`PI_HOP_TIMEOUT_MS`).
