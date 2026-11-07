// Orchestra agent extension: identity injection, edit guard, messaging/spawn tools.
// Loaded with `pi --extension <dist/index.js>` at spawn time (never as a core edit).
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function env(key: string): string | undefined {
	const v = process.env[key];
	return v && v.length > 0 ? v : undefined;
}

function supervisorBase(): string | undefined {
	return env("ORCHESTRA_SUPERVISOR_URL") ?? "http://127.0.0.1:7788";
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
	const base = supervisorBase()!;
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`supervisor ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return (await res.json()) as T;
}

export default function (pi: ExtensionAPI): void {
	const agentId = env("ORCHESTRA_AGENT_ID") ?? "unknown";
	const agentName = env("ORCHESTRA_AGENT_NAME") ?? "agent";
	const role = env("ORCHESTRA_AGENT_ROLE") ?? "builder";

	// Identity + rules: injected once at start; roster refreshed by messages.
	pi.on("before_agent_start", async (event) => {
		const { sections } = event.systemPromptOptions;
		sections["orchestra_identity"] = [
			`You are ${agentName} (agent ${agentId}), role ${role}.`,
			"Rules: one writer per file (lease enforced by code, not prompt); never revert others' commits; delivery is at-least-once — dedupe by message id; 'done' means checks pass, not your claim.",
			"Tools: send_message/read_inbox/reply for coordination; spawn only via supervisor (budget/depth enforced); shot/dom tools for UI verification.",
		].join("\n");
		return undefined;
	});

	// Edit guard: block edits to files leased by another agent. Reads always allowed.
	pi.on("tool_call", async (event) => {
		if (
			event.toolName === "read" ||
			event.toolName === "grep" ||
			event.toolName === "find" ||
			event.toolName === "ls"
		)
			return undefined;
		if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return undefined;
		const input = event.input as Record<string, unknown>;
		const filePath = (input.path ?? input.file_path ?? input.filePath ?? "") as string;
		if (!filePath) return undefined; // bash without path → let bash guard handle below
		try {
			const verdict = await postJson<{ allowed: boolean; reason: string; ownerName?: string; ownerTask?: string }>(
				"/can-edit",
				{ agentId, filePath },
			);
			if (!verdict.allowed) {
				const who = verdict.ownerName
					? ` Owned by ${verdict.ownerName}${verdict.ownerTask ? ` (task ${verdict.ownerTask})` : ""}.`
					: "";
				return { block: true, reason: `Blocked: ${verdict.reason}. ${who} Message them with send_message.` };
			}
		} catch (e) {
			// Supervisor unreachable → allow (fail-open) to avoid deadlocks; lease is retried next call.
			// Production should fail-closed; logged as info via notify when UI exists.
		}
		return undefined;
	});

	const sendParams = Type.Object({
		toAgentId: Type.Optional(Type.String()),
		toRole: Type.Optional(Type.String()),
		broadcast: Type.Optional(Type.Boolean()),
		threadId: Type.Optional(Type.String()),
		inReplyTo: Type.Optional(Type.String()),
		type: Type.Union([
			Type.Literal("handoff"),
			Type.Literal("blocked"),
			Type.Literal("question"),
			Type.Literal("answer"),
			Type.Literal("info"),
			Type.Literal("done"),
		]),
		body: Type.String(),
	});
	const sendTool: ToolDefinition = {
		name: "send_message",
		label: "Message",
		description:
			"Send a typed, durable message to a teammate, a role, or broadcast. Delivery is at-least-once (dedupe by id). No wait — use read_inbox/reply.",
		parameters: sendParams as never,
		async execute(_id, params) {
			const p = params as {
				toAgentId?: string;
				toRole?: string;
				broadcast?: boolean;
				threadId?: string;
				inReplyTo?: string;
				type: "handoff" | "blocked" | "question" | "answer" | "info" | "done";
				body: string;
			};
			const res = await postJson<{ message: { id: string } }>("/message", { fromAgentId: agentId, ...p });
			return { content: [{ type: "text", text: `sent ${res.message.id}` }], details: res.message };
		},
	};
	const inboxTool: ToolDefinition = {
		name: "read_inbox",
		label: "Inbox",
		description: "Read unread messages (marks delivered). Call after send_message / on each turn boundary.",
		parameters: Type.Object({}) as never,
		async execute() {
			const res = await postJson<{ items: { message: { id: string; type: string; body: string } }[] }>("/inbox", {
				agentId,
			});
			const text =
				res.items.map((it) => `[${it.message.type}] ${it.message.id}: ${it.message.body}`).join("\n") || "(empty)";
			return { content: [{ type: "text", text }], details: res.items };
		},
	};
	const replyTool: ToolDefinition = {
		name: "reply",
		label: "Reply",
		description: "Reply to a message (marks acked). Provide the message id from read_inbox.",
		parameters: Type.Object({ messageId: Type.String(), type: Type.String(), body: Type.String() }) as never,
		async execute(_id, params) {
			const p = params as { messageId: string; type: string; body: string };
			const sent = await postJson<{ message: { id: string } }>("/message", {
				fromAgentId: agentId,
				type: p.type,
				body: p.body,
				inReplyTo: p.messageId,
			});
			await postJson("/ack", { messageId: p.messageId, agentId });
			return { content: [{ type: "text", text: `replied ${sent.message.id}` }], details: sent.message };
		},
	};
	const spawnTool: ToolDefinition = {
		name: "spawn",
		label: "Spawn",
		description: "Ask supervisor to spawn a teammate (depth, concurrency, budget slice enforced by harness).",
		parameters: Type.Object({
			name: Type.String(),
			role: Type.String(),
			taskSpec: Type.String(),
			ownsGlobs: Type.Optional(Type.Array(Type.String())),
		}) as never,
		async execute(_id, params) {
			const p = params as { name: string; role: string; taskSpec: string; ownsGlobs?: string[] };
			const res = await postJson<{ agentId: string; name: string }>("/spawn", { parentAgentId: agentId, ...p });
			return { content: [{ type: "text", text: `spawned ${res.name} (${res.agentId})` }], details: res };
		},
	};

	pi.registerTool(sendTool);
	pi.registerTool(inboxTool);
	pi.registerTool(replyTool);
	pi.registerTool(spawnTool);
}
