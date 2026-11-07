// Comms watch: deterministic detectors over the message log + event log.
import type { Store } from "@earendil-works/pi-orchestra-core";

export interface CommIssue {
	type:
		| "unanswered-question"
		| "chatter-no-progress"
		| "contradicting-handoff"
		| "ignored-blocked"
		| "owned-file-contention";
	agentId: string;
	detail: string;
}

export function detectComms(store: Store, opts: { questionTimeoutMs?: number; now?: number } = {}): CommIssue[] {
	const now = opts.now ?? Date.now();
	const timeout = opts.questionTimeoutMs ?? 60_000;
	const issues: CommIssue[] = [];
	const agents = store.listAgents();
	// Load messages via inbox-like queries: use deliveries + messages tables directly.
	const rows = store.db.prepare(`SELECT m.* FROM messages m ORDER BY created_at`).all() as Record<string, unknown>[];
	const byThread = new Map<string, Record<string, unknown>[]>();
	for (const r of rows) {
		const tid = r.thread_id == null ? (r.id as string) : String(r.thread_id);
		if (!byThread.has(tid)) byThread.set(tid, []);
		byThread.get(tid)!.push(r);
	}
	for (const [, msgs] of byThread) {
		// Unanswered question past timeout.
		for (const m of msgs) {
			if (String(m.type) !== "question") continue;
			const createdAt = Number(m.created_at);
			if (now - createdAt < timeout) continue;
			const answered = msgs.some(
				(x) =>
					x.in_reply_to === m.id &&
					(String(x.type) === "answer" || String(x.type) === "handoff" || String(x.type) === "blocked"),
			);
			if (!answered) {
				issues.push({
					type: "unanswered-question",
					agentId: String(m.from_agent_id),
					detail: `question ${String(m.id)} unanswered ${Math.round((now - createdAt) / 1000)}s`,
				});
			}
		}
		// Back-and-forth without progress: 6+ messages in thread with zero commits (events with kind tool_execution cannot check commits here; approximate by no check_runs in window).
		if (msgs.length >= 6) {
			const spanMs = Number(msgs[msgs.length - 1]!.created_at) - Number(msgs[0]!.created_at);
			if (spanMs < 120_000) {
				issues.push({
					type: "chatter-no-progress",
					agentId: String(msgs[0]!.from_agent_id),
					detail: `${msgs.length} messages in ${Math.round(spanMs / 1000)}s with no check progress`,
				});
			}
		}
	}
	// Ignored blocked: agent received blocked but then sent done/handoff touching same file (approximate: blocked exists, later done from recipient).
	const deliveries = store.db
		.prepare(`SELECT message_id, recipient FROM deliveries WHERE state='acked' ORDER BY rowid`)
		.all() as { message_id: string; recipient: string }[];
	const msgById = new Map<string, Record<string, unknown>>();
	for (const r of rows) msgById.set(String(r.id), r);
	for (const d of deliveries) {
		const m = msgById.get(d.message_id);
		if (!m || String(m.type) !== "blocked") continue;
		// Look for a later message from recipient claiming done in same thread (or globally after).
		const later = rows.find(
			(x) =>
				String(x.from_agent_id) === d.recipient &&
				String(x.type) === "done" &&
				Number(x.created_at) > Number(m.created_at),
		);
		if (later) {
			issues.push({
				type: "ignored-blocked",
				agentId: d.recipient,
				detail: `agent ignored blocked ${d.message_id} then claimed done (${String(later.id)})`,
			});
		}
	}
	// Owned-file contention: two agents sent tool events touching same path (leases table shows contention history via events? approximate by leases with different agents same prefix).
	const leases = store.listLeases();
	const byPathPrefix = new Map<string, string[]>();
	for (const l of leases) {
		const prefix = l.path.split("/").slice(0, 2).join("/");
		if (!byPathPrefix.has(prefix)) byPathPrefix.set(prefix, []);
		byPathPrefix.get(prefix)!.push(l.agentId);
	}
	for (const [prefix, owners] of byPathPrefix) {
		if (new Set(owners).size > 1) {
			for (const o of new Set(owners)) {
				issues.push({ type: "owned-file-contention", agentId: o, detail: `contention on ${prefix}` });
			}
		}
	}
	void agents;
	return issues;
}
