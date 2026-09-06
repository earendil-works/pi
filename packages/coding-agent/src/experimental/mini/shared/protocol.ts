/** Service contracts and everything that crosses the wire. */

import type { HarnessEvent, LaneSnapshot } from "@earendil-works/pi-agent-core";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";

/** Commands answer with data, never exceptions, exactly like a remote call would. */
export type CommandResult = { ok: true } | { ok: false; error: string };

/** Durable model identity. Nothing outside a worker holds a `Model` object. */
export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelSummary extends ModelRef {
	name: string;
}

export interface ProviderAccount {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	configured: boolean;
	/** Where the credential came from, for display: "stored", "environment", an env var name. */
	source?: string;
	/** False for ambient credentials pi cannot collect itself, such as AWS profiles or env vars. */
	interactive: boolean;
	methodName?: string;
}

export interface ModelsState {
	readonly models: readonly ModelSummary[];
	readonly accounts: readonly ProviderAccount[];
	readonly refreshing: boolean;
}

/** An auth prompt without its `AbortSignal`: the part that can cross a transport. */
export type AuthPromptRequest = AuthPrompt extends infer Prompt
	? Prompt extends unknown
		? Omit<Prompt, "signal">
		: never
	: never;

/** A service seen from the other side of a connection: every method returns a promise. */
export type Remote<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** Names one service and carries its call and event types. Names are globally unique. */
export interface ServiceToken<TApi extends object, TEvent = never> {
	readonly name: string;
	/** Phantom, never read: keeps the types attached to the token. */
	readonly types?: (api: TApi, event: TEvent) => void;
}

export function defineService<TApi extends object, TEvent = never>(name: string): ServiceToken<TApi, TEvent> {
	return { name };
}

export interface SessionSummary {
	id: string;
	path: string;
	cwd: string;
	createdAt: number;
}

export interface SessionSnapshot {
	sessionId: string;
	cwd: string;
	sessionPath: string;
	/** Carries the lane configuration, queues, and stats: no side-channel replication. */
	lane: LaneSnapshot;
	models: ModelsState;
}

/** Everything the `Models` service publishes. */
export type ModelsEvent =
	| { type: "state"; state: ModelsState }
	// Login runs the wrong way round: the request is an event, the answer is an ordinary call.
	| { type: "prompt"; requestId: string; request: AuthPromptRequest }
	| { type: "notice"; notice: AuthEvent };

/** The login half, for whatever drives the dialog. */
export type AuthEventPayload = Exclude<ModelsEvent, { type: "state" }>;

/** One presentation's subscription: a `lane.watch()` in the worker, named so its events can be filtered. */
export interface LaneSubscription {
	subscriptionId: string;
	snapshot: SessionSnapshot;
}

/** Lane events are addressed to the subscription whose watch produced them. */
export interface LaneEvent {
	subscriptionId: string;
	event: HarnessEvent;
}

export interface LaneServiceApi {
	/**
	 * Capture a snapshot and open a subscription for one presentation. Its events are addressed to
	 * `presentationId`, so the server routes them instead of broadcasting. Buffered until `start`.
	 */
	watch(presentationId: string): Promise<LaneSubscription>;
	/** Begin delivery, draining everything buffered since the snapshot. */
	start(subscriptionId: string): Promise<void>;
	unwatch(subscriptionId: string): Promise<void>;
	prompt(text: string): Promise<CommandResult>;
	steer(text: string): Promise<CommandResult>;
	followUp(text: string): Promise<CommandResult>;
	compact(): Promise<CommandResult>;
	abort(): Promise<CommandResult>;
	setModel(ref: ModelRef): Promise<CommandResult>;
}

export interface ModelsServiceApi {
	refresh(): Promise<CommandResult>;
	login(providerId: string, authType: "oauth" | "api_key"): Promise<CommandResult>;
	authReply(requestId: string, answer: string | null): Promise<void>;
}

/** Provided by a worker so the server can identify the session it opened, without naming lane methods. */
export interface WorkerServiceApi {
	describe(): Promise<{ sessionId: string }>;
}

export interface SessionsServiceApi {
	list(): Promise<SessionSummary[]>;
	attach(sessionId: string | null, cwd: string, presentationId: string): Promise<string>;
}

/** Provided by the worker. One subscription per presentation; `watch` again to rebase. */
export const Lane = defineService<LaneServiceApi, LaneEvent>("lane");
/** Provided by the worker. Small enough to publish whole. */
export const Models = defineService<ModelsServiceApi, ModelsEvent>("models");
/** Provided by the worker, consumed only by the server. */
export const Worker = defineService<WorkerServiceApi>("worker");
/** Provided by the server. */
export const Sessions = defineService<SessionsServiceApi>("sessions");
