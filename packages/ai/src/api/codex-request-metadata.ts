import type { AgentRequestIdentity } from "../types.ts";

export interface CodexRequestMetadata {
	clientMetadata: Record<string, string>;
	headers: Record<string, string>;
}

function stringifyAsciiJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-\uffff]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

export function buildCodexRequestMetadata(
	identity: AgentRequestIdentity | undefined,
): CodexRequestMetadata | undefined {
	if (!identity) return undefined;

	const windowId = identity.windowId ?? `${identity.threadId}:0`;
	const turnMetadata = stringifyAsciiJson({
		...(identity.installationId ? { installation_id: identity.installationId } : {}),
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		turn_id: identity.turnId,
		window_id: windowId,
		request_kind: identity.requestKind,
		turn_started_at_unix_ms: identity.startedAt,
	});
	const clientMetadata: Record<string, string> = {
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		turn_id: identity.turnId,
		"x-codex-window-id": windowId,
		"x-codex-turn-metadata": turnMetadata,
	};
	const headers: Record<string, string> = {
		originator: "pi",
		"session-id": identity.sessionId,
		"thread-id": identity.threadId,
		"x-client-request-id": identity.threadId,
		"x-codex-window-id": windowId,
		"x-codex-turn-metadata": turnMetadata,
	};
	if (identity.installationId) {
		clientMetadata["x-codex-installation-id"] = identity.installationId;
		headers["x-codex-installation-id"] = identity.installationId;
	}

	return { clientMetadata, headers };
}
