# pi-lincx-team

A sequential agent team for [Pi](https://pi.dev): a roster grid, seven agent
contracts, per-agent model/tool routing, and fresh-context hops. No `subagent`
tool, no orchestration framework — you route, it executes.

```
Scout: map the auth token flow                    ← runs in this session
Planner: plan the retry cap using those findings  ← runs in this session
Coder: implement the plan                         ← runs in this session
Reviewer! git diff                                ← fresh-context hop
Issuer: file the follow-up we spotted             ← this session or a hop
```

## Install

```sh
pi install git:github.com/<owner>/pi-lincx-team@v1.0.0
bash ~/.pi/agent/git/github.com/<owner>/pi-lincx-team/install.sh   # adds pi-hop
```

Restart Pi, then `/agents-list` and `/agents-grid 3`.

`install.sh` only links `bin/pi-hop` into `~/.local/bin`. Add `--with-policy`
if you also want this repo's `AGENTS.md` linked as `~/.pi/agent/AGENTS.md`
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
git clone git@github.com:<owner>/pi-lincx-team.git ~/src/pi-lincx-team
cp ~/src/pi-lincx-team/extensions/agents-grid.ts ~/.pi/agent/extensions/
cp ~/src/pi-lincx-team/agents/*.md ~/.pi/agent/agents/
bash ~/src/pi-lincx-team/install.sh
```

Copying the `.md` files into `~/.pi/agent/agents/` makes them *user* agents,
which outrank package agents — useful when you want to fork a contract locally.

## Usage

| You type | What happens |
|---|---|
| `Reviewer: check the auth change` | the `reviewer` contract runs in the current session |
| `Reviewer! check the auth change` | headless `pi -p` child with that contract; answer arrives as a follow-up |
| `Approacher: size this up` | alias → `planner` |
| `/agents-list` | roster with model, thinking, tools, source |
| `/agents-grid 3` | pin 3 columns (`1`-`6`, `off`, `on`) |
| `/agents-team` | switch team; `all` removes the gate |
| `/agents-hop reviewer review HEAD` | hop without the `!` syntax |
| `/agents-stop` | SIGTERM running hops |

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

Edit an agent by editing its markdown. **Frontmatter** carries identity and
routing (`name`, `description`, `aliases`, `tools`, `model`, `thinking`); the
**body** is the contract. Body edits apply on the next message; frontmatter
edits on the next 30-second roster refresh.

## Layout

```
agents/            seven contracts + teams.yaml (the team definition)
extensions/        agents-grid.ts — roster, teams, hops (no dependencies)
bin/pi-hop         one-hop CLI for shells, hooks and CI
AGENTS.md          optional user policy describing the pipeline
install.sh         links pi-hop (and optionally AGENTS.md)
```

## Precedence

Roster (first match wins, flat scan): `.pi/agents/` in the cwd → `~/.pi/agent/agents/`
→ this package's `agents/`. Teams: this package's `teams.yaml` → user
`~/.pi/agent/agents/teams.yaml` → project `.pi/agents/teams.yaml`.

A named team is a gate: addressing an agent outside it is refused with a
warning instead of launched. `teams.state.json` (which team you last picked) is
per machine and deliberately git-ignored.

## Requirements

Pi ≥ 1.5.0. Hops shell out to the `pi` binary on `PATH` (override with
`PI_HOP_BIN`), cap at 3 concurrent runs, and time out after 20 minutes
(`PI_HOP_TIMEOUT_MS`).
