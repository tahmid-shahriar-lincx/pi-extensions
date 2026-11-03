#!/usr/bin/env bash
# install.sh — link the pieces a Pi package cannot install by itself.
#
#   bash install.sh                 # link bin/pi-hop into ~/.local/bin
#   bash install.sh --with-policy   # also adopt AGENTS.user.md as the user policy
#   bash install.sh --bin ~/bin     # different bin directory
#
# The extension and the agents need no linking: `pi install <this-repo>` puts
# them on disk and agents-grid.ts reads ./agents next to itself.

set -euo pipefail

quiet=0
with_policy=0
bindir=${PI_HOP_BINDIR:-$HOME/.local/bin}

while [ $# -gt 0 ]; do
	case "$1" in
	--quiet) quiet=1 ;;
	--with-policy) with_policy=1 ;;
	--bin)
		bindir=${2:?--bin needs a directory}
		shift
		;;
	-h | --help)
		sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		printf 'install.sh: unknown option %s\n' "$1" >&2
		exit 2
		;;
	esac
	shift
done

root=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
say() { [ "$quiet" -eq 1 ] || printf '%s\n' "$1"; }

mkdir -p "$bindir"
ln -sfn "$root/bin/pi-hop" "$bindir/pi-hop"
say "linked $bindir/pi-hop → $root/bin/pi-hop"
case ":$PATH:" in
*":$bindir:"*) ;;
*) say "note: $bindir is not on PATH; add it to use pi-hop" ;;
esac

if [ "$with_policy" -eq 1 ]; then
	mkdir -p "$agent_dir"
	if [ -f "$agent_dir/AGENTS.md" ] && [ ! -L "$agent_dir/AGENTS.md" ]; then
		backup="$agent_dir/AGENTS.md.bak.$(date +%Y%m%d-%H%M%S)"
		cp "$agent_dir/AGENTS.md" "$backup"
		say "backed up existing policy → $backup"
	fi
	ln -sfn "$root/AGENTS.user.md" "$agent_dir/AGENTS.md"
	say "linked $agent_dir/AGENTS.md → $root/AGENTS.user.md"
fi

say ""
say "next:  pi install git:github.com/tahmid-shahriar-lincx/pi-extensions@v1.0.0"
say "then restart pi and run /agents-list"
