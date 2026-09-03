import { type Context, defineService, type ReplicatedState } from "@earendil-works/chord";
import type { ServerId } from "@earendil-works/pi-protocol";

export interface SessionAddress {
	serverId: ServerId;
	sessionId: string;
}

export interface SessionSummary extends SessionAddress {
	createdAt: number;
}

export interface SessionCreateOptions {
	id?: string;
}

export interface SessionDirectoryState {
	revision: number;
	sessions: SessionSummary[];
}

export interface SessionDirectory {
	readonly state: ReplicatedState<SessionDirectoryState>;
}

export const SessionDirectory = defineService<SessionDirectory>("pi.session-directory");

export interface SessionManagement {
	create(options: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

export const SessionManagement = defineService<SessionManagement>("pi.session-management");
