import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { cliVersions, opencodeBin, runCapture } from "./cli.ts";
import { serializeTools } from "./prompt.ts";

export const AGENT_ID = "pi-model";
const SESSION_DELETE_TIMEOUT_MS = 10_000;

/** Cap on tracked Pi sessions; the oldest entry is evicted with cleanup. */
const MAX_TRACKED_PI_SESSIONS = 10;
const pendingSessionDeletions = new Set<Promise<void>>();

/** Best-effort, bounded deletion; shutdown also awaits one-shot deletions. */
export function deleteOpenCodeSession(sessionId: string | undefined): Promise<void> {
	if (!sessionId) return Promise.resolve();
	const args = ["session", "delete", sessionId];
	if (cliVersions.get(opencodeBin())?.startsWith("2.")) args.push("--standalone");
	const task = runCapture(args, undefined, SESSION_DELETE_TIMEOUT_MS).then(
		() => undefined,
		() => undefined,
	);
	pendingSessionDeletions.add(task);
	void task.finally(() => pendingSessionDeletions.delete(task));
	return task;
}

type PiSessionState = {
	/** Lazily created per-Pi-session OpenCode project directory (#74). */
	dirPromise?: Promise<string>;
	/** Recorded OpenCode session ID reused across turns (#75). */
	opencodeSessionId?: string;
	/** Model ID the recorded session was created with. */
	modelId?: string;
	/** Serialized tool list the recorded session was created with (#76). */
	toolsKey?: string;
	/** System prompt the recorded session was created with (#76). */
	systemPrompt?: string;
	/** Serialized transcript prefix already sent to the recorded session. */
	sentParts?: string[];
};

const piSessions = new Map<string, PiSessionState>();

/** Number of tracked Pi sessions (exposed for tests). */
export function trackedPiSessionCount(): number {
	return piSessions.size;
}

export function getPiSessionState(piSessionId: string): PiSessionState {
	const existing = piSessions.get(piSessionId);
	if (existing) {
		// Refresh recency so eviction drops the least-recently-used entry.
		piSessions.delete(piSessionId);
		piSessions.set(piSessionId, existing);
		return existing;
	}
	const state: PiSessionState = {};
	piSessions.set(piSessionId, state);
	while (piSessions.size > MAX_TRACKED_PI_SESSIONS) {
		const oldest = piSessions.keys().next();
		if (oldest.done) break;
		void cleanupPiSessionState(oldest.value as string);
	}
	return state;
}

export function ensurePiSessionDir(state: PiSessionState): Promise<string> {
	state.dirPromise ??= createTempAgentDir().catch((error) => {
		if (state.dirPromise) state.dirPromise = undefined;
		throw error;
	});
	return state.dirPromise;
}

/**
 * Remove a Pi session's project directory and delete its OpenCode session
 * record — the explicit cleanup path for session teardown (#74). With no
 * argument, every tracked session is cleaned up.
 */
export async function cleanupPiSessionState(piSessionId?: string): Promise<void> {
	const ids = piSessionId === undefined ? [...piSessions.keys()] : [piSessionId];
	await Promise.all(
		ids.map(async (id) => {
			const state = piSessions.get(id);
			if (!state) return;
			piSessions.delete(id);
			const deletion = deleteOpenCodeSession(state.opencodeSessionId);
			state.opencodeSessionId = undefined;
			if (state.dirPromise) {
				const dirPromise = state.dirPromise;
				state.dirPromise = undefined;
				const dir = await dirPromise.catch(() => undefined);
				if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
			}
			await deletion;
		}),
	);
	if (piSessionId === undefined) await Promise.all([...pendingSessionDeletions]);
}

/** Forget a broken session so the next turn starts fresh (#75). */
export function dropOpencodeSession(state: PiSessionState): void {
	deleteOpenCodeSession(state.opencodeSessionId);
	state.opencodeSessionId = undefined;
	state.modelId = undefined;
	state.toolsKey = undefined;
	state.systemPrompt = undefined;
	state.sentParts = undefined;
}

/**
 * Decide whether the next turn may continue the recorded OpenCode session
 * (#75, #76). Continuation requires the same model, the same serialized
 * tool list and system prompt, and a transcript that extends — never
 * rewrites — the previously sent prefix, with at least one new message.
 */
export function continuationDelta(
	state: PiSessionState,
	modelId: string,
	context: Context,
	parts: string[],
): string[] | undefined {
	if (!state.opencodeSessionId) return undefined;
	if (state.modelId !== modelId) return undefined;
	if ((state.toolsKey ?? "") !== serializeTools(context.tools)) return undefined;
	if ((state.systemPrompt ?? "") !== (context.systemPrompt ?? "")) return undefined;
	const sent = state.sentParts ?? [];
	if (sent.length >= parts.length) return undefined;
	for (let index = 0; index < sent.length; index += 1) {
		if (sent[index] !== parts[index]) return undefined;
	}
	return parts.slice(sent.length);
}

export async function createTempAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-opencode-cli-bridge-"));
	const configDir = join(dir, ".opencode");
	const agentsDir = join(configDir, "agents");
	const pluginsDir = join(configDir, "plugins");
	await mkdir(agentsDir, { recursive: true });
	await mkdir(pluginsDir, { recursive: true });
	// `opencode run` streams an OpenCode compaction summary as reply text, where
	// its quoted markers break the turn. Pi owns compaction, so overflow must
	// surface as an error instead.
	await writeFile(join(configDir, "opencode.json"), JSON.stringify({ compaction: { auto: false } }), "utf8");
	await writeFile(
		join(agentsDir, `${AGENT_ID}.md`),
		`---
description: Pi bridge agent. Pi tool calls are emitted as text markers.
mode: primary
permission:
  "*": ask
---
You are the OpenCode side of a Pi Coding Agent bridge. Do not use OpenCode native tools. Reply in plain text, or emit <pi_tool_call>{"name":"...","arguments":{...}}</pi_tool_call> exactly when the prompt asks you to request a Pi tool.
`,
		"utf8",
	);
	// Zen's free tier requires OpenCode's normal tool declarations to remain in
	// the request. Permission `deny` removes them before inference and is now
	// rejected as a third-party client. Keep declarations intact, but block
	// every native execution before side effects occur. The agent's `ask`
	// permission keeps declarations too, and `opencode run` auto-rejects asks.
	// V2 relies on that permission guard; the legacy plugin only guards V1.
	await writeFile(
		join(pluginsDir, "pi-native-tool-blocker.js"),
		`export const PiNativeToolBlocker = async () => ({
  "tool.execute.before": async (input) => {
    throw new Error("Native OpenCode tool " + input.tool + " is disabled in the Pi bridge. Request the equivalent Pi tool instead: reply with <pi_tool_call>{\\"name\\":\\"tool_name\\",\\"arguments\\":{}}</pi_tool_call> using a tool from the Pi tool list.")
  },
})
`,
		"utf8",
	);
	return dir;
}
