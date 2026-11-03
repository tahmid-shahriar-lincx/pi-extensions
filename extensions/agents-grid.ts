/**
 * Agents Grid — standalone agent roster, teams and sequential hops.
 *
 * No dependency on pi-subagents and no `subagent` tool: the grid is the UI, and
 * every execution path is either this session or a headless `pi -p` child.
 *
 * Cards render as:
 *
 *   ○ Reviewer                     idle, description underneath
 *   ● Coder 45s ↓1.2k ↑3.4k Add retry…  running hop, elapsed + tokens
 *   ✓ Reviewer 18s                 finished hop (flashes, then decays)
 *   ✗ Issuer                       failed hop
 *
 * Addressing (typed in the editor):
 *   Reviewer: check the auth change      → run the contract in THIS session
 *   Reviewer! check the auth change      → fresh-context hop (headless pi)
 * The hop's answer arrives as a follow-up message; the parent never pays for
 * the child's exploration, only for the report.
 *
 * Hop execution: `pi -ne --no-session --mode json` with `--tools`, `--model`
 * and `--thinking` taken from the agent file's frontmatter. Nothing else is
 * consulted, so an agent file fully describes its own hop.
 *
 * Teams: ~/.pi/agent/agents/teams.yaml (user) and <cwd>/.pi/agents/teams.yaml
 * (project wins on name clash). Members match agent `name` or `aliases`,
 * case-insensitive; "all" is always available and applies no gate. The active
 * team is persisted in ~/.pi/agent/agents/teams.state.json. A named team is
 * enforced here, in this extension — addressing an agent outside the team is
 * refused instead of launched.
 *
 * Commands:
 *   /agents-team                 switch active team (persisted)
 *   /agents-grid [1-6|off|on]    set column count (default auto), toggle widget
 *   /agents-list                 list the visible roster with sources
 *   /agents-hop <agent> <task>   run a fresh-context hop without the ! syntax
 *   /agents-stop [agent|all]     abort running hops
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	aliases: string[];
	description: string;
	source: "project" | "user" | "package";
	file: string;
	tools?: string;
	model?: string;
	thinking?: string;
}

interface CardState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	goal: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	startedAt: number;
	lastDoneAt: number;
	runCount: number; // active hops for this agent right now
}

interface Hop {
	agent: string;
	startedAt: number;
	controller: AbortController;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	aliases?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
};

// ── Constants ────────────────────────────────────

// declared pipeline order; unknown agents keep relative (alphabetical) order
const PIPELINE_ORDER = ["scout", "spotter", "planner", "coder", "simplifier", "reviewer", "issuer"];
const TEAM_STATE_FILE = "teams.state.json";
const DONE_FLASH_MS = 6000;
const MAX_HOPS = 3;
const HOP_TIMEOUT_MS = Number(process.env.PI_HOP_TIMEOUT_MS ?? 20 * 60 * 1000);
const HOP_BIN = process.env.PI_HOP_BIN ?? "pi";
const HOP_MAX_BUFFER = 64 * 1024 * 1024;

// ── Roster helpers ───────────────────────────────

function displayName(name: string): string {
	return name
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

function parseList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseAgentFile(filePath: string, source: AgentDef["source"]): AgentDef | null {
	try {
		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(readFileSync(filePath, "utf-8"));
		if (typeof frontmatter.name !== "string" || !frontmatter.name) return null;
		const description =
			typeof frontmatter.description === "string" && frontmatter.description
				? frontmatter.description
				: (body.trim().split("\n").find((l) => l.trim())?.slice(0, 80) ?? "");
		const def: AgentDef = { name: frontmatter.name, aliases: parseList(frontmatter.aliases), description, source, file: filePath };
		const tools = parseList(frontmatter.tools);
		if (tools.length > 0) def.tools = tools.join(",");
		const model = optionalString(frontmatter.model);
		if (model) def.model = model;
		const thinking = optionalString(frontmatter.thinking);
		if (thinking) def.thinking = thinking;
		return def;
	} catch {
		return null;
	}
}

function scanDir(dir: string, source: AgentDef["source"]): AgentDef[] {
	if (!existsSync(dir)) return [];
	const out: AgentDef[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const def = parseAgentFile(join(dir, file), source);
			if (def) out.push(def);
		}
	} catch {
		/* unreadable — skip */
	}
	return out;
}

function pipelineSort(defs: AgentDef[]): AgentDef[] {
	return [...defs].sort((a, b) => {
		const ia = PIPELINE_ORDER.indexOf(a.name.toLowerCase());
		const ib = PIPELINE_ORDER.indexOf(b.name.toLowerCase());
		if (ia !== -1 && ib !== -1) return ia - ib;
		if (ia !== -1) return -1;
		if (ib !== -1) return 1;
		return a.name.localeCompare(b.name);
	});
}

/** The contract portion of an agent file: frontmatter stripped, body trimmed. */
function loadAgentBody(def: AgentDef): string {
	try {
		const { body } = parseFrontmatter<AgentFrontmatter>(readFileSync(def.file, "utf-8"));
		return body.trim();
	} catch {
		return def.description;
	}
}

// ── Bundled agents ───────────────────────────────

/**
 * Agents that ship next to this extension: `<package>/agents` when installed as
 * a Pi package, or the user directory when the file was dropped there by hand.
 * undefined means "nothing bundled to scan", so the same directory is never
 * scanned twice under two labels.
 */
function bundledAgentsDir(): string | undefined {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const candidate = resolve(here, "..", "agents");
		if (!existsSync(candidate)) return undefined;
		if (candidate === resolve(join(getAgentDir(), "agents"))) return undefined;
		return candidate;
	} catch {
		return undefined;
	}
}

// ── Teams YAML ───────────────────────────────────

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		if (line.trim().startsWith("#")) continue;
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			const member = itemMatch[1].trim().split(/\s+#/)[0].trim();
			if (member) teams[current].push(member);
		}
	}
	return teams;
}

// ── Formatting helpers ───────────────────────────

function fmtTokens(n: number): string {
	if (!n) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k";
	return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function fmtCost(usd: number): string {
	if (!usd) return "";
	if (usd < 0.01) return ` $${usd.toFixed(4)}`;
	return ` $${usd.toFixed(2)}`;
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

// ── Hop process ──────────────────────────────────

interface ChildResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Run the hop child with stdin closed immediately. A headless `pi -p` blocks
 * while stdin is an open pipe, so the parent has to end it right after spawn;
 * without that the child never exits and the hop looks hung.
 */
function runChild(
	bin: string,
	args: string[],
	options: { cwd: string; timeout: number; signal: AbortSignal; maxBuffer: number },
): Promise<ChildResult> {
	return new Promise((resolvePromise) => {
		const child = execFile(
			bin,
			args,
			{ cwd: options.cwd, timeout: options.timeout, maxBuffer: options.maxBuffer },
			(err: any, stdout, stderr) => {
				const missing = err?.code === "ENOENT";
				resolvePromise({
					stdout: String(stdout ?? ""),
					stderr: missing ? `cannot run \`${bin}\` (not found on PATH)` : String(stderr ?? ""),
					code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
					killed: Boolean(err?.killed),
				});
			},
		);
		child.stdin?.end();
		const onAbort = () => child.kill("SIGTERM");
		options.signal.addEventListener("abort", onAbort, { once: true });
		child.on("exit", () => options.signal.removeEventListener("abort", onAbort));
	});
}

// ── Hop result parsing ───────────────────────────

interface HopResult {
	text: string;
	input: number;
	output: number;
	cost: number;
}

/** Read `pi --mode json` output: final assistant text plus cumulative usage. */
function parseHopJson(stdout: string): HopResult {
	let text = "";
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let event: any;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (event?.type === "turn_end" && event.message?.usage) {
			input += Number(event.message.usage.input ?? 0) || 0;
			output += Number(event.message.usage.output ?? 0) || 0;
			cost += Number(event.message.usage.cost?.total ?? 0) || 0;
		}
		if (event?.type === "message_end" && event.message?.role === "assistant" && Array.isArray(event.message.content)) {
			const messageText = event.message.content
				.filter((part: any) => part?.type === "text" && typeof part.text === "string")
				.map((part: any) => part.text as string)
				.join("")
				.trim();
			if (messageText) text = messageText;
		}
	}
	return { text, input, output, cost };
}

// ── Extension ────────────────────────────────────

export default function agentsGrid(pi: ExtensionAPI) {
	const cards = new Map<string, CardState>(); // key: agent name lowercase
	const hops = new Map<string, Hop>(); // key: run key
	let explicitCols = 0; // 0 = auto
	let widgetVisible = true;
	let uiCtx: any;
	let tick = 0;

	let allDefs: AgentDef[] = [];
	let resolver = new Map<string, AgentDef>(); // name/alias (lowercase) → def
	let teams: Record<string, string[]> = {};
	let activeTeam = "all";
	let teamCards: CardState[] = []; // ordered member cards for the active team

	function ensureCard(def: AgentDef): CardState {
		const key = def.name.toLowerCase();
		let card = cards.get(key);
		if (!card) {
			card = {
				def,
				status: "idle",
				goal: "",
				inputTokens: 0,
				outputTokens: 0,
				costUsd: 0,
				startedAt: 0,
				lastDoneAt: 0,
				runCount: 0,
			};
			cards.set(key, card);
		} else {
			card.def = def; // refresh description/contract/tools
		}
		return card;
	}

	// ── Roster + teams ────────────────────────────

	function loadRoster(cwd: string) {
		// project dirs first (project wins on name clash), then user, then the
		// agents bundled with the installed package (lowest priority).
		const bundled = bundledAgentsDir();
		const defs: AgentDef[] = [
			...scanDir(join(cwd, "agents"), "project"),
			...scanDir(join(cwd, ".claude", "agents"), "project"),
			...scanDir(join(cwd, ".pi", "agents"), "project"),
			...scanDir(join(getAgentDir(), "agents"), "user"),
			...(bundled ? scanDir(bundled, "package") : []),
		];
		const seen = new Set<string>();
		const unique: AgentDef[] = [];
		for (const def of defs) {
			if (seen.has(def.name.toLowerCase())) continue;
			seen.add(def.name.toLowerCase());
			unique.push(def);
		}
		allDefs = unique;

		// prune cards for agents that disappeared
		for (const key of [...cards.keys()]) {
			if (!seen.has(key) && (cards.get(key)?.runCount ?? 0) === 0) cards.delete(key);
		}

		resolver = new Map();
		for (const def of allDefs) {
			for (const key of [def.name, ...def.aliases]) {
				const k = key.toLowerCase();
				if (!resolver.has(k)) resolver.set(k, def);
			}
		}
		for (const def of allDefs) ensureCard(def);

		// teams: bundled defaults, then user, then project (highest priority)
		const teamFiles = [
			...(bundled ? [join(bundled, "teams.yaml")] : []),
			join(getAgentDir(), "agents", "teams.yaml"),
			join(cwd, ".pi", "agents", "teams.yaml"),
		];
		teams = {};
		for (const p of teamFiles) {
			if (!existsSync(p)) continue;
			try {
				teams = { ...teams, ...parseTeamsYaml(readFileSync(p, "utf-8")) };
			} catch {
				/* malformed — keep previous */
			}
		}

		activateTeam(activeTeam);
	}

	function teamMembers(name: string): AgentDef[] {
		const list = teams[name];
		if (!list) return [];
		const out: AgentDef[] = [];
		const used = new Set<string>();
		for (const member of list) {
			const def = resolver.get(member.toLowerCase());
			if (!def || used.has(def.name.toLowerCase())) continue;
			used.add(def.name.toLowerCase());
			out.push(def);
		}
		return out;
	}

	function activateTeam(name: string) {
		if (name !== "all" && !teams[name]) name = "all";
		activeTeam = name;
		teamCards = name === "all" ? [] : teamMembers(name).map((d) => ensureCard(d));
	}

	/** Undefined when the agent may run; a message when the team gate refuses. */
	function teamRefusal(def: AgentDef): string | undefined {
		if (activeTeam === "all") return undefined;
		if (teamMembers(activeTeam).some((member) => member.name === def.name)) return undefined;
		return `${displayName(def.name)} is outside the ${activeTeam} team. /agents-team switches teams.`;
	}

	function persistTeam() {
		try {
			writeFileSync(join(getAgentDir(), "agents", TEAM_STATE_FILE), JSON.stringify({ activeTeam }, null, 2) + "\n");
		} catch {
			/* best-effort */
		}
	}

	function loadPersistedTeam(): string | undefined {
		try {
			const v = JSON.parse(readFileSync(join(getAgentDir(), "agents", TEAM_STATE_FILE), "utf-8")).activeTeam;
			return typeof v === "string" ? v : undefined;
		} catch {
			return undefined;
		}
	}

	// ── Visible cards ─────────────────────────────

	// done/error flashes decay to idle after the window (hops have no external
	// status source, so the display layer owns the decay).
	function effectiveStatus(card: CardState, now: number): CardState["status"] {
		if ((card.status === "done" || card.status === "error") && card.runCount === 0 && now - card.lastDoneAt >= DONE_FLASH_MS) {
			return "idle";
		}
		return card.status;
	}

	function visibleCards(now: number): CardState[] {
		if (activeTeam === "all") {
			return pipelineSort(Array.from(cards.values()).map((c) => c.def))
				.map((d) => cards.get(d.name.toLowerCase())!)
				.filter(Boolean);
		}
		const memberSet = new Set(teamCards);
		const others = Array.from(cards.values()).filter(
			(c) => !memberSet.has(c) && (c.runCount > 0 || effectiveStatus(c, now) === "running"),
		);
		return [...teamCards, ...others];
	}

	// ── Hop execution ─────────────────────────────

	function hopArgs(def: AgentDef, prompt: string): string[] {
		const args = ["-ne", "--no-session", "--mode", "json"];
		if (def.model) args.push("--model", def.model);
		if (def.thinking) args.push("--thinking", def.thinking);
		if (def.tools) args.push("--tools", def.tools);
		args.push("-p", prompt);
		return args;
	}

	function hopPrompt(def: AgentDef, task: string): string {
		return [
			loadAgentBody(def),
			"",
			"---",
			"",
			`# Task`,
			"",
			task,
			"",
			`Work in the current directory (${uiCtx?.cwd ?? process.cwd()}). Report your result as your final message.`,
		].join("\n");
	}

	function inject(content: string, triggerTurn: boolean) {
		try {
			pi.sendMessage({ customType: "agents-grid-hop", content, display: true }, { triggerTurn, deliverAs: "followUp" });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			uiCtx?.ui.notify(`Hop finished but could not be delivered: ${message}`, "error");
		}
	}

	async function startHop(def: AgentDef, task: string, ctx: any) {
		if (teamRefusal(def)) {
			ctx.ui.notify(teamRefusal(def)!, "warning");
			return;
		}
		if (hops.size >= MAX_HOPS) {
			ctx.ui.notify(`Too many hops running (${hops.size}). /agents-stop stops one.`, "warning");
			return;
		}

		const key = `${def.name.toLowerCase()}-${Date.now()}`;
		const controller = new AbortController();
		const card = ensureCard(def);
		const startedAt = Date.now();

		hops.set(key, { agent: def.name.toLowerCase(), startedAt, controller });
		card.status = "running";
		card.startedAt = startedAt;
		card.goal = task.replace(/\s+/g, " ").trim();
		card.runCount += 1;
		card.inputTokens = 0;
		card.outputTokens = 0;
		card.costUsd = 0;
		render();
		updateStatusLine();

		let result: HopResult = { text: "", input: 0, output: 0, cost: 0 };
		let failed = false;
		let failure = "";

		try {
			const res = await runChild(HOP_BIN, hopArgs(def, hopPrompt(def, task)), {
				cwd: ctx.cwd ?? process.cwd(),
				signal: controller.signal,
				timeout: HOP_TIMEOUT_MS,
				maxBuffer: HOP_MAX_BUFFER,
			});
			result = parseHopJson(res.stdout ?? "");
			if (res.killed) {
				failed = true;
				failure = controller.signal.aborted ? "stopped" : "timed out or hit the output limit";
			} else if ((res.code ?? 0) !== 0) {
				failed = true;
				const stderr = (res.stderr ?? "").trim().split("\n").slice(-3).join("\n");
				failure = `exit ${res.code}${stderr ? `\n${stderr}` : ""}`;
			} else if (!result.text) {
				failed = true;
				failure = "the child produced no final message";
			}
		} catch (err) {
			failed = true;
			failure = err instanceof Error ? err.message : String(err);
		} finally {
			hops.delete(key);
			card.runCount = Math.max(0, card.runCount - 1);
			card.inputTokens = result.input;
			card.outputTokens = result.output;
			card.costUsd = result.cost;
			card.status = failed ? "error" : "done";
			card.lastDoneAt = Date.now();
			render();
			updateStatusLine();
		}

		const elapsed = fmtElapsed(Date.now() - startedAt);
		const tokens = result.input || result.output ? ` · ↓${fmtTokens(result.input)} ↑${fmtTokens(result.output)}` : "";
		const meta = `${displayName(def.name)} hop · ${elapsed}${tokens}${fmtCost(result.cost)}`;

		if (failed) {
			inject(`**${meta}** — failed: ${failure}`, false);
			return;
		}
		inject(`**${meta}**\n\n${result.text}`, true);
	}

	function stopHops(target: string | undefined, ctx: any) {
		const wanted = target?.trim().toLowerCase();
		let stopped = 0;
		for (const hop of hops.values()) {
			if (wanted && wanted !== "all" && hop.agent !== wanted) continue;
			hop.controller.abort();
			stopped += 1;
		}
		ctx?.ui.notify(stopped > 0 ? `Stopped ${stopped} hop${stopped === 1 ? "" : "s"}` : "No matching hops running", "info");
	}

	// ── Rendering ─────────────────────────────────

	// Compact two-line card:
	//   ● Reviewer 45s
	//   ↓1.2k ↑3.4k Review authentication bounda…
	function renderCard(card: CardState, colWidth: number, theme: Theme, now: number): string[] {
		const w = Math.max(12, colWidth);
		const status = effectiveStatus(card, now);

		const statusColor = status === "idle" ? "dim" : status === "running" ? "accent" : status === "done" ? "success" : "error";
		const statusIcon = status === "idle" ? "○" : status === "running" ? "●" : status === "done" ? "✓" : "✗";

		const name = displayName(card.def.name);
		const count = card.runCount > 1 ? ` ×${card.runCount}` : "";
		const elapsed =
			status === "running" && card.startedAt
				? ` ${fmtElapsed(now - card.startedAt)}`
				: (status === "done" || status === "error") && card.lastDoneAt && card.startedAt
					? ` ${fmtElapsed(Math.max(0, card.lastDoneAt - card.startedAt))}`
					: "";

		const namePlain = `${name}${count}${elapsed}`;
		const nameBudget = w - 4; // icon + spaces
		const nameStr = truncate(namePlain, nameBudget);
		const line1 =
			theme.fg(statusColor as any, statusIcon) +
			" " +
			theme.fg("accent", theme.bold(nameStr.slice(0, Math.min(name.length, nameStr.length)))) +
			theme.fg("dim", nameStr.slice(Math.min(name.length, nameStr.length)));
		const line1Pad = " ".repeat(Math.max(0, w - 2 - visibleWidth(nameStr)));

		let workStr: string;
		if (status === "running" || ((card.inputTokens || card.outputTokens) && status !== "idle")) {
			const tok = `↓${fmtTokens(card.inputTokens)} ↑${fmtTokens(card.outputTokens)}`;
			const goal = card.goal || card.def.description;
			workStr = goal ? `${tok} ${truncate(goal, Math.max(1, w - tok.length - 1))}` : tok;
		} else {
			workStr = status === "idle" ? card.def.description : card.goal || card.def.description;
		}
		const line2 = theme.fg("muted", truncate(workStr, w));
		const line2Pad = " ".repeat(Math.max(0, w - visibleWidth(truncate(workStr, w))));

		return [line1 + line1Pad, line2 + line2Pad];
	}

	function render() {
		if (!widgetVisible || !uiCtx || uiCtx.mode !== "tui") return;
		uiCtx.ui.setWidget("agents-grid", (_tui: any, theme: Theme) => {
			const text = new Text("", 0, 1);
			return {
				render(width: number): string[] {
					if (cards.size === 0) {
						text.setText(theme.fg("dim", "No agents found. Add .md files to agents/, .pi/agents/ or ~/.pi/agent/agents/"));
						return text.render(width);
					}

					const now = Date.now();
					const list = visibleCards(now);
					const MAX_SHOWN = 24;
					const shown = list.length > MAX_SHOWN ? list.slice(0, MAX_SHOWN) : list;

					// fit columns to width: widest grid that keeps cards ≥ 22 cols
					let cols =
						explicitCols || (shown.length <= 3 ? Math.max(1, shown.length) : shown.length <= 8 ? Math.min(3, shown.length) : 4);
					while (cols > 1 && (width - 2 * (cols - 1)) / cols < 22) cols--;
					cols = Math.max(1, Math.min(cols, shown.length));

					const gap = 2;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
					const header =
						theme.fg("dim", `${activeTeam} · ${list.length} agent${list.length === 1 ? "" : "s"} · `) +
						theme.fg("accent", `${list.filter((c) => c.runCount > 0 || effectiveStatus(c, now) === "running").length} active`);

					const lines: string[] = [header];
					for (let i = 0; i < shown.length; i += cols) {
						const rowCards = shown.slice(i, i + cols);
						const cells = rowCards.map((c) => renderCard(c, colWidth, theme, now));
						while (cells.length < cols) cells.push(["", ""]);
						for (let l = 0; l < 2; l++) {
							lines.push(
								cells
									.map((cell) => (cell[l] || "").padEnd(colWidth))
									.join(" ".repeat(gap))
									.trimEnd(),
							);
						}
					}

					if (list.length > shown.length) lines.push(theme.fg("dim", ` … +${list.length - shown.length} more`));
					text.setText(lines.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	function updateStatusLine() {
		if (!uiCtx) return;
		const now = Date.now();
		const visible = visibleCards(now);
		const active = visible.filter((c) => c.runCount > 0 || effectiveStatus(c, now) === "running").length;
		uiCtx.ui.setStatus("agents-grid", `${activeTeam} · ${visible.length} agents · ${active} active`);
	}

	// ── Heartbeat ──────────────────────────────────

	const heartbeat = setInterval(() => {
		tick += 1;
		if (tick % 30 === 0 && uiCtx) loadRoster(uiCtx.cwd); // pick up new agent/team files
		render(); // tick elapsed timers
	}, 1000);

	// ── Commands ───────────────────────────────────

	pi.registerCommand("agents-team", {
		description: "Switch the active agent team",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			const names = Object.keys(teams);
			if (names.length === 0) {
				ctx.ui.notify("No teams defined. Add one to ~/.pi/agent/agents/teams.yaml or .pi/agents/teams.yaml", "warning");
				return;
			}

			const entries = [
				{ team: "all", label: `all — (${allDefs.length}) every discovered agent` },
				...names.map((team) => {
					const members = teamMembers(team).map((d) => displayName(d.name));
					return { team, label: `${team}${team === activeTeam ? " ✓" : ""} — (${members.length}) ${members.join(", ")}` };
				}),
			];

			const options = entries.map((e) => e.label);
			const choice = await ctx.ui.select(`Select Team (active: ${activeTeam})`, options);
			if (choice === undefined) return;
			const idx = options.indexOf(choice);
			if (idx === -1) return;

			activateTeam(entries[idx].team);
			persistTeam();
			render();
			updateStatusLine();
			const roster = (activeTeam === "all" ? visibleCards(Date.now()).map((c) => c.def) : teamMembers(activeTeam))
				.map((def) => displayName(def.name))
				.join(", ");
			ctx.ui.notify(activeTeam === "all" ? `Team: all — ${roster}` : `Team: ${activeTeam} — addressing limited to ${roster}`, "info");
		},
	});

	pi.registerCommand("agents-grid", {
		description: "Agents grid: /agents-grid <1-6|off|on>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5", "6", "off", "on"].map((v) => ({
				value: v,
				label: v === "off" ? "off — hide grid" : v === "on" ? "on — show grid" : `${v} columns`,
			}));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const arg = (args || "").trim().toLowerCase();
			if (arg === "off") {
				widgetVisible = false;
				if (ctx.mode === "tui") ctx.ui.setWidget("agents-grid", undefined);
				ctx.ui.notify("Grid hidden (/agents-grid on to show)", "info");
				return;
			}
			if (arg === "on" || arg === "") {
				widgetVisible = true;
				render();
				ctx.ui.notify(`Grid on — team ${activeTeam}, ${visibleCards(Date.now()).length} agents`, "info");
				return;
			}
			const n = parseInt(arg, 10);
			if (n >= 1 && n <= 6) {
				explicitCols = n;
				widgetVisible = true;
				render();
				ctx.ui.notify(`Grid set to ${n} columns`, "info");
			} else {
				ctx.ui.notify("Usage: /agents-grid <1-6|off|on>", "error");
			}
		},
	});

	pi.registerCommand("agents-list", {
		description: "List agents visible in the grid",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			const lines = visibleCards(Date.now())
				.map((c) => {
					const status = c.status === "idle" ? "○" : c.status === "running" ? "●" : c.status === "done" ? "✓" : "✗";
					const route = [c.def.model, c.def.thinking, c.def.tools ? `tools: ${c.def.tools}` : ""].filter(Boolean).join(" · ");
					return `${status} ${displayName(c.def.name)} [${c.def.source}] — ${c.def.description}${route ? `\n     ${route}` : ""}`;
				})
				.join("\n");
			ctx.ui.notify(`Team ${activeTeam}:\n${lines || "No agents"}`, "info");
		},
	});

	pi.registerCommand("agents-hop", {
		description: "Run a fresh-context hop: /agents-hop <agent> <task>",
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const raw = (args || "").trim();
			const match = raw.match(/^(\S+)\s+([\s\S]+)$/);
			if (!match) {
				ctx.ui.notify("Usage: /agents-hop <agent> <task>", "error");
				return;
			}
			const def = resolver.get(match[1].toLowerCase());
			if (!def) {
				ctx.ui.notify(`Unknown agent "${match[1]}". /agents-list shows the roster.`, "error");
				return;
			}
			void startHop(def, match[2].trim(), ctx);
			ctx.ui.notify(`${displayName(def.name)} hop started`, "info");
		},
	});

	pi.registerCommand("agents-stop", {
		description: "Stop running hops: /agents-stop [agent|all]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const names = [...new Set([...hops.values()].map((h) => h.agent))];
			const items = ["all", ...names].map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, ctx) => {
			uiCtx = ctx;
			stopHops((args || "").trim() || "all", ctx);
		},
	});

	// ── Direct Addressing ────────────────────────
	// "Scout: map token handling"    → run the contract in this session
	// "Reviewer! review the diff"    → fresh-context hop, result delivered later
	// Matches any roster agent by name, alias, or display name (case/space/
	// hyphen-insensitive). Never fires on steering input; unknown prefixes
	// ("Note: ...") pass through untouched.

	pi.on("input", async (event, ctx) => {
		if (!(event.source === "interactive" || event.source === "rpc")) return undefined;
		if (event.streamingBehavior === "steer") return undefined;

		const hopMatch = event.text.match(/^([A-Za-z][A-Za-z -]*?)!\s+([\s\S]+)$/);
		const inlineMatch = hopMatch ? null : event.text.match(/^([A-Za-z][A-Za-z -]*?):\s+([\s\S]+)$/);
		const match = hopMatch ?? inlineMatch;
		if (!match) return undefined;

		const task = match[2].trim();
		if (!task) return undefined;

		const normalize = (s: string) => s.toLowerCase().replace(/[ -]/g, "");
		const prefix = normalize(match[1]);
		let best: AgentDef | undefined;
		let bestLen = -1;
		for (const def of allDefs) {
			for (const name of [def.name, displayName(def.name), ...def.aliases]) {
				if (prefix !== normalize(name)) continue;
				if (name.length > bestLen) {
					best = def;
					bestLen = name.length;
				}
			}
		}
		if (!best) return undefined;
		const addressed = best;

		const refusal = teamRefusal(addressed);
		if (refusal) {
			ctx.ui.notify(refusal, "warning");
			return { action: "handled" as const };
		}

		if (hopMatch) {
			void startHop(addressed, task, ctx);
			ctx.ui.notify(`${displayName(addressed.name)} hop started — result arrives as a follow-up`, "info");
			return { action: "handled" as const };
		}

		return {
			action: "transform" as const,
			text:
				`Act as the "${addressed.name}" specialist for this task and do the work yourself. ` +
				`Follow the contract below exactly; it replaces your default workflow for this task. ` +
				`Do not dispatch to another agent and do not hand the task back.\n\n` +
				`<contract agent="${addressed.name}">\n${loadAgentBody(addressed)}\n</contract>\n\n` +
				`<task>\n${task}\n</task>`,
		};
	});

	// ── Lifecycle ──────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		widgetVisible = true;
		const persistedTeam = loadPersistedTeam();
		activeTeam = persistedTeam ?? "all";
		loadRoster(ctx.cwd);
		// default to the first team defined in a teams.yaml only when nothing
		// was persisted
		const firstDefined = Object.keys(teams)[0];
		if (persistedTeam === undefined && firstDefined) {
			activateTeam(firstDefined);
		}
		render();
		updateStatusLine();
	});

	pi.on("session_shutdown", async () => {
		clearInterval(heartbeat);
		stopHops(undefined, undefined);
	});
}
