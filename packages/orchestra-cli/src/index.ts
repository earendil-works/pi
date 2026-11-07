// Orchestra CLI rendering helpers (pure, testable).
import type { Store } from "@earendil-works/pi-orchestra-core";

export function renderStatus(store: Store, opts: { runId?: string; elapsedMs?: number } = {}): string {
	const agents = store.listAgents();
	const tasks = store.listTasks();
	const leases = store.listLeases();
	const escalations = store.listEscalations().filter((e) => e.state === "open");
	const elapsed = opts.elapsedMs !== undefined ? formatElapsed(opts.elapsedMs) : "—";
	const lines: string[] = [];
	lines.push(
		`ORCHESTRA ${opts.runId ?? "dev"}  elapsed ${elapsed}  agents ${agents.length}  escalations ${escalations.length}`,
	);
	lines.push("AGENTS");
	lines.push("  name     role      task  state");
	for (const a of agents)
		lines.push(
			`  ${a.name.slice(0, 8).padEnd(8)} ${a.role.slice(0, 9).padEnd(9)} ${(a.taskId?.slice(0, 6) ?? "—").padEnd(6)} ${a.state}`,
		);
	lines.push("TASKS");
	for (const t of tasks.slice(0, 20))
		lines.push(`  ${t.id.slice(0, 6)} ${t.state} ${t.title.slice(0, 60)} attempt ${t.attempts}`);
	lines.push("LEASES");
	for (const l of leases.slice(0, 20)) {
		const owner = store.getAgent(l.agentId);
		lines.push(`  ${l.path} → ${owner?.name ?? l.agentId}`);
	}
	lines.push(`ESCALATIONS (${escalations.length})`);
	for (const e of escalations.slice(0, 10)) lines.push(`  ${e.id.slice(0, 6)} ${e.reason.slice(0, 100)}`);
	return lines.join("\n");
}

export function renderReport(store: Store): string {
	const runs = store.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT 5`).all() as Record<
		string,
		unknown
	>[];
	const lines: string[] = ["ORCHESTRA REPORT"];
	if (runs.length === 0) lines.push("  (no runs yet)");
	for (const r of runs) {
		const reprompts = store.db.prepare(`SELECT COUNT(*) AS n FROM reprompts`).get() as { n: number } | undefined;
		lines.push(
			`  run ${String(r.run_id)} goal=${String(r.goal).slice(0, 80)} finished=${r.finished_at == null ? "no" : "yes"} reprompts=${String(r.reprompt_rounds ?? 0)}`,
		);
		lines.push(`    gap types: ${String(r.gap_types ?? "[]")}`);
		lines.push(
			`    spend: ${String(r.spend_per_agent ?? "{}")} thinking: ${String(r.thinking_per_agent ?? "{}")} timeToDone: ${r.time_to_done_ms ?? "—"}`,
		);
		void reprompts;
	}
	lines.push(
		`  agents: ${store.listAgents().length} tasks: ${store.listTasks().length} escalations: ${store.listEscalations().filter((e) => e.state === "open").length} open`,
	);
	return lines.join("\n");
}

export function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	const hh = Math.floor(s / 3600);
	const mm = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
