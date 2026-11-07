// HTTP IPC DTOs: agent-ext <-> supervisor (localhost JSON).
import type { MessageRecord, MessageType } from "./types.ts";

export interface CanEditRequest {
	agentId: string;
	filePath: string;
}
export interface CanEditResponse {
	allowed: boolean;
	reason: string;
	ownerName?: string;
	ownerTask?: string;
	task?: string;
}

export interface SendMessageRequest {
	fromAgentId: string;
	toAgentId?: string;
	toRole?: string;
	broadcast?: boolean;
	threadId?: string;
	inReplyTo?: string;
	type: MessageType;
	body: string;
}
export interface SendMessageResponse {
	message: MessageRecord;
}

export interface InboxRequest {
	agentId: string;
}
export interface AckRequest {
	messageId: string;
	agentId: string;
}

export interface SpawnRequest {
	parentAgentId?: string;
	name: string;
	role: string;
	taskSpec: string;
	ownsGlobs?: string[];
	model?: string;
}
export interface SpawnResponse {
	agentId: string;
	name: string;
}

export interface HealthResponse {
	ok: true;
	ts: number;
}
