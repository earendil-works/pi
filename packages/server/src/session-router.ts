import { randomUUID } from "node:crypto";
import type { JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context, type SessionMetadata } from "@earendil-works/pi-agent-core";
import type { RpcTarget, SessionTarget } from "@earendil-works/pi-protocol";
import { ServerDrainingError, SessionNotAttachedError } from "./errors.ts";
import type { RoutedSessionAttachment, RoutedSessionHandle, ServerHost } from "./types.ts";

class SessionCleanupError extends AggregateError {}

interface ClientAttachment {
	readonly id: string;
	readonly client: object;
	readonly session: HostedSession;
	readonly operations: Set<Promise<unknown>>;
	acquiring?: Promise<RoutedSessionAttachment>;
	lease?: RoutedSessionAttachment;
	releasing?: Promise<void>;
}

interface HostedSession {
	readonly id: string;
	readonly handle: RoutedSessionHandle;
	readonly attachments: Set<ClientAttachment>;
}

interface SessionRouterOptions<TMetadata extends SessionMetadata> {
	host: ServerHost<TMetadata>;
	serverId: string;
	isClosing: () => boolean;
	publishAttachment(client: object, attachment: SessionTarget | undefined, context: Context): Promise<void>;
	reportError: (error: unknown) => void;
}

export class SessionRouter<TMetadata extends SessionMetadata = SessionMetadata> {
	private readonly options: SessionRouterOptions<TMetadata>;
	private readonly hostedSessions = new Map<string, HostedSession>();
	private readonly openingSessions = new Map<string, Promise<HostedSession>>();
	private readonly attachmentsByClient = new Map<object, ClientAttachment>();
	private readonly disconnectedClients = new Set<object>();
	private readonly clientOperations = new Map<object, Promise<void>>();
	private closePromise?: Promise<void>;

	constructor(options: SessionRouterOptions<TMetadata>) {
		this.options = options;
	}

	async executeServiceCall(
		call: ServiceCall,
		target: RpcTarget,
		client: object,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => Promise<void>,
		context: Context,
	): Promise<JsonValue | undefined> {
		const admitted = await this.runForClient(client, () =>
			this.startServiceCall(client, target, call, publish, context),
		);
		return admitted.result;
	}

	attachClient(client: object, sessionId: string, context: Context): Promise<void> {
		if (this.options.isClosing()) return Promise.reject(new ServerDrainingError());
		return this.runForClient(client, () => this.attachClientNow(client, sessionId, context));
	}

	detachClient(client: object, context: Context): Promise<void> {
		return this.runForClient(client, async () => {
			const attachment = this.attachmentsByClient.get(client);
			if (attachment) await this.releaseAttachment(attachment, context);
		});
	}

	async removeSession(sessionId: string, context: Context): Promise<void> {
		if (this.options.isClosing()) throw new ServerDrainingError();
		const hosted = this.hostedSessions.get(sessionId);
		if (hosted === undefined) return;
		const errors: unknown[] = [];
		const releases = await Promise.allSettled(
			[...hosted.attachments].map((attachment) => this.releaseAttachment(attachment, context)),
		);
		for (const result of releases) if (result.status === "rejected") errors.push(result.reason);
		try {
			await hosted.handle.close(context);
		} catch (error) {
			errors.push(error);
		}
		if (this.hostedSessions.get(sessionId) === hosted) this.hostedSessions.delete(sessionId);
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, `Failed to close Session ${sessionId}`);
	}

	async disconnect(client: object, context: Context): Promise<void> {
		this.disconnectedClients.add(client);
		try {
			await this.runForClient(client, async () => {
				const attachment = this.attachmentsByClient.get(client);
				if (attachment) await this.releaseAttachment(attachment, context, false);
			});
		} finally {
			this.disconnectedClients.delete(client);
		}
	}

	close(context: Context): Promise<void> {
		this.closePromise ??= this.closeInternal(context);
		return this.closePromise;
	}

	private async closeInternal(context: Context): Promise<void> {
		const operationPromises = [...this.clientOperations.values()];
		const openingPromises = [...this.openingSessions.values()];
		const [operationResults, openingResults] = await Promise.all([
			Promise.allSettled(operationPromises),
			Promise.allSettled(openingPromises),
		]);
		const closeErrors: unknown[] = [];
		for (const result of [...operationResults, ...openingResults]) {
			if (result.status !== "rejected") continue;
			this.options.reportError(result.reason);
			if (result.reason instanceof SessionCleanupError) closeErrors.push(result.reason);
		}
		const attachmentResults = await Promise.allSettled(
			[...this.hostedSessions.values()].flatMap((session) =>
				[...session.attachments].map((attachment) => this.releaseAttachment(attachment, context)),
			),
		);
		for (const result of attachmentResults) {
			if (result.status === "rejected") closeErrors.push(result.reason);
		}
		const hosted = [...this.hostedSessions.values()];
		const closeResults = await Promise.allSettled(hosted.map(({ handle }) => handle.close(context)));
		for (let index = 0; index < closeResults.length; index++) {
			const result = closeResults[index]!;
			const session = hosted[index]!;
			if (result.status === "fulfilled") {
				if (this.hostedSessions.get(session.id) === session) this.hostedSessions.delete(session.id);
				continue;
			}
			this.options.reportError(result.reason);
			closeErrors.push(result.reason);
		}
		this.attachmentsByClient.clear();
		this.clientOperations.clear();
		if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Failed to close routed Sessions");
	}

	private runForClient<T>(client: object, operation: () => Promise<T>): Promise<T> {
		const previous = this.clientOperations.get(client) ?? Promise.resolve();
		const result = previous.catch(() => {}).then(operation);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.clientOperations.set(client, tail);
		void tail.finally(() => {
			if (this.clientOperations.get(client) === tail) this.clientOperations.delete(client);
		});
		return result;
	}

	private async attachClientNow(client: object, sessionId: string, context: Context): Promise<void> {
		if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
		const current = this.attachmentsByClient.get(client);
		if (current?.session.id === sessionId) return;
		const hosted = await this.acquire(sessionId, context);
		if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
		if (current) await this.releaseAttachment(current, context, false);
		const attachment: ClientAttachment = {
			id: randomUUID(),
			client,
			session: hosted,
			operations: new Set(),
		};
		hosted.attachments.add(attachment);
		try {
			const acquiring = Promise.resolve(hosted.handle.attachClient(context));
			attachment.acquiring = acquiring;
			attachment.lease = await acquiring;
		} catch (error) {
			hosted.attachments.delete(attachment);
			throw error;
		}
		if (
			this.hostedSessions.get(hosted.id) !== hosted ||
			!hosted.attachments.has(attachment) ||
			this.disconnectedClients.has(client) ||
			this.options.isClosing()
		) {
			await this.releaseAttachment(attachment, context);
			throw new ServerDrainingError();
		}
		this.attachmentsByClient.set(client, attachment);
		await this.options.publishAttachment(
			client,
			{ serverId: this.options.serverId, sessionId, attachmentId: attachment.id },
			context,
		);
	}

	private async startServiceCall(
		client: object,
		target: RpcTarget,
		call: ServiceCall,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => Promise<void>,
		context: Context,
	): Promise<{ result: Promise<JsonValue | undefined> }> {
		const attachment = this.requireAttachment(client, target);
		const result = attachment.lease!.invokeService(
			call,
			(subscriptionId, update, updateContext) => publish(subscriptionId, update, updateContext),
			context,
		);
		this.trackOperation(attachment, result);
		return { result };
	}

	private trackOperation(attachment: ClientAttachment, result: Promise<unknown>): void {
		attachment.operations.add(result);
		const remove = (): void => {
			attachment.operations.delete(result);
		};
		void result.then(remove, remove);
	}

	private requireAttachment(client: object, target: RpcTarget): ClientAttachment {
		if (this.options.isClosing() || this.disconnectedClients.has(client)) throw new ServerDrainingError();
		if (!("sessionId" in target)) throw new SessionNotAttachedError();
		const attachment = this.attachmentsByClient.get(client);
		if (!attachment || attachment.session.id !== target.sessionId || attachment.id !== target.attachmentId) {
			throw new SessionNotAttachedError();
		}
		return attachment;
	}

	private releaseAttachment(attachment: ClientAttachment, context: Context, publish = true): Promise<void> {
		attachment.releasing ??= (async () => {
			const errors: unknown[] = [];
			try {
				await Promise.allSettled(attachment.operations);
				try {
					const lease = attachment.lease ?? (await attachment.acquiring);
					if (lease) await lease.release(context);
				} catch (error) {
					errors.push(error);
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "Failed to release Session attachment");
			} finally {
				await this.clearAttachment(attachment, context, publish);
			}
		})();
		return attachment.releasing;
	}

	private async clearAttachment(attachment: ClientAttachment, context: Context, publish: boolean): Promise<void> {
		attachment.session.attachments.delete(attachment);
		if (this.attachmentsByClient.get(attachment.client) === attachment) {
			this.attachmentsByClient.delete(attachment.client);
			if (publish) await this.options.publishAttachment(attachment.client, undefined, context);
		}
	}

	private async acquire(sessionId: string, context: Context): Promise<HostedSession> {
		const existing = this.hostedSessions.get(sessionId);
		if (existing) return existing;
		const opening = this.openingSessions.get(sessionId);
		if (opening) return opening;
		const pending = this.open(sessionId, context);
		this.openingSessions.set(sessionId, pending);
		try {
			return await pending;
		} finally {
			if (this.openingSessions.get(sessionId) === pending) this.openingSessions.delete(sessionId);
		}
	}

	private async open(sessionId: string, context: Context): Promise<HostedSession> {
		const metadata = await this.options.host.resolveSession(sessionId, context);
		const handle = await this.options.host.openSession(metadata, context);
		if (this.options.isClosing()) {
			try {
				await handle.close(context);
			} catch (error) {
				this.options.reportError(error);
				throw new SessionCleanupError(
					[new ServerDrainingError(), error],
					"Failed to close routed Session acquired while draining",
				);
			}
			throw new ServerDrainingError();
		}
		const hosted: HostedSession = { id: metadata.id, handle, attachments: new Set() };
		this.hostedSessions.set(hosted.id, hosted);
		if (handle.terminated) {
			void handle.terminated.then(
				(error) => this.invalidate(hosted, error),
				(error: unknown) => this.invalidate(hosted, error instanceof Error ? error : new Error(String(error))),
			);
		}
		return hosted;
	}

	private invalidate(hosted: HostedSession, error: Error | undefined): void {
		if (this.hostedSessions.get(hosted.id) !== hosted) return;
		this.hostedSessions.delete(hosted.id);
		for (const attachment of hosted.attachments) {
			void this.releaseAttachment(attachment, BACKGROUND_CONTEXT).catch((releaseError: unknown) =>
				this.options.reportError(releaseError),
			);
		}
		if (error) this.options.reportError(error);
	}
}
