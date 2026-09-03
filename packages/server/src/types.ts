import type { JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import type { Context, SessionMetadata } from "@earendil-works/pi-agent-core";
import type { ServerListener } from "./listener.ts";

export interface ServerOptions {
	listeners: readonly ServerListener[];
	/** Stable logical server identity supplied by the installation or profile. */
	serverId: string;
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	onConnectionCountChanged?: (count: number) => void;
	onError?: (error: Error) => void;
}

export type MaybePromise<T> = T | Promise<T>;

/** One presentation connection's live capability for a hosted Session. */
export interface RoutedSessionAttachment {
	/** Route one contract-agnostic service operation to the attached Session endpoint. */
	invokeService(
		call: ServiceCall,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
		context: Context,
	): Promise<JsonValue | undefined>;
	release(context: Context): MaybePromise<void>;
}

/** Presentation-scoped routing capabilities available to server service implementations. */
export interface RoutedServerPresentation {
	attachSession(sessionId: string, context: Context): Promise<void>;
	detachSession(context: Context): Promise<void>;
	/** Release routed attachments and handles before the application deletes durable metadata. */
	prepareSessionRemoval(sessionId: string, context: Context): Promise<void>;
}

/** One connection's server-scoped service endpoint. */
export interface RoutedServerServiceAttachment {
	invokeService(
		call: ServiceCall,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
		context: Context,
	): Promise<JsonValue | undefined>;
	release(context: Context): MaybePromise<void>;
}

export interface RoutedServerServiceHost {
	attachClient(presentation: RoutedServerPresentation, context: Context): MaybePromise<RoutedServerServiceAttachment>;
}

/** A process-safe handle that acquires presentation-scoped Session capabilities. */
export interface RoutedSessionHandle {
	attachClient(context: Context): MaybePromise<RoutedSessionAttachment>;
	/** Resolves with an error for unexpected termination, or undefined after an expected close. */
	readonly terminated?: Promise<Error | undefined>;
	close(context: Context): Promise<void>;
}

/** Application capabilities used by server-wide management and Session routing. */
export interface ServerHost<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly serverServices: RoutedServerServiceHost;
	/** Resolve one durable Session ID or throw a bounded routing error. */
	resolveSession(sessionId: string, context: Context): Promise<TMetadata>;
	openSession(metadata: TMetadata, context: Context): Promise<RoutedSessionHandle>;
}
