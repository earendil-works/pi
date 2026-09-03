import {
	type Context,
	createRemoteServiceBinding,
	type MutableReplicatedState,
	type RemoteServiceBinding,
	type RemoteServiceSource,
	type RemoteServices,
	type RemoteServiceTransport,
	type ReplicatedState,
	replicatedState,
	type Service,
	type ServiceCatalogueEntry,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Client, createClientServiceTransport } from "@earendil-works/pi-client";
import type { SessionTarget } from "@earendil-works/pi-protocol";

export type ServerConnectionState =
	| { status: "connecting"; attempt: number }
	| { status: "connected"; since: string }
	| { status: "disconnected"; since: string; reason: string; retryAt: string | null };

export type SessionAttachmentState =
	| { status: "detached" }
	| { status: "attaching" | "attached" | "degraded"; sessionId: string };

export interface ServerServiceSource extends RemoteServiceSource {
	readonly connection: ReplicatedState<ServerConnectionState>;
	dispose(context: Context): Promise<void>;
}

export interface SessionServiceSource extends RemoteServiceSource {
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	/** Wait for the exact current attachment generation to finish hydrating. */
	whenAttached(sessionId: string, context: Context): Promise<void>;
	/** Wait for every binding to finish releasing the previous attachment. */
	whenDetached(context: Context): Promise<void>;
	dispose(context: Context): Promise<void>;
}

export interface ServiceSourceOptions {
	readonly onError?: (error: Error) => void;
}

class RoutedServiceBinding implements RemoteServices {
	readonly #services: RemoteServiceBinding;
	readonly #getBound: () => boolean;
	readonly #onActivate: (context: Context) => Promise<void>;
	readonly #remove: () => void;
	#activated = false;
	#activationComplete = false;

	constructor(options: {
		readonly services: readonly { readonly id: string }[];
		readonly transport: RemoteServiceTransport;
		readonly getBound: () => boolean;
		readonly assertAccess: () => void;
		readonly onError: (error: Error) => void;
		readonly onActivate?: (context: Context) => Promise<void>;
		readonly remove: () => void;
	}) {
		this.#services = createRemoteServiceBinding({
			services: options.services,
			transport: options.transport,
			bound: false,
			assertAccess: options.assertAccess,
			onError: options.onError,
		});
		this.#getBound = options.getBound;
		this.#onActivate = options.onActivate ?? (() => Promise.resolve());
		this.#remove = options.remove;
	}

	use<T>(service: Service<T>): T {
		return this.#services.use(service);
	}

	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void {
		return this.#services.observe(service, handler);
	}

	async ready(context: Context): Promise<void> {
		if (!this.#activated) {
			this.#activated = true;
			await this.#services.rebind(this.#getBound(), context);
		}
		await this.serviceReady(context);
		if (!this.#activationComplete) {
			await this.#onActivate(context);
			this.#activationComplete = true;
		}
	}

	serviceReady(context: Context): Promise<void> {
		return this.#services.ready(context);
	}

	updateBound(bound: boolean, context: Context): Promise<void> {
		return this.#activated ? this.#services.rebind(bound, context) : Promise.resolve();
	}

	async dispose(context: Context): Promise<void> {
		this.#remove();
		await this.#services.dispose(context);
	}
}

class ServerServiceSourceImpl implements ServerServiceSource {
	readonly acceptsUnavailableServices = false;
	readonly connection: ReplicatedState<ServerConnectionState>;
	readonly #client: Client;
	readonly #transport: RemoteServiceTransport;
	readonly #bindings = new Set<RoutedServiceBinding>();
	readonly #removeConnectionListener: () => void;
	readonly #onError: (error: Error) => void;
	#transition = Promise.resolve();
	#connectionAttempt: number;
	#disposed = false;

	constructor(client: Client, options: ServiceSourceOptions) {
		this.#client = client;
		this.#transport = createClientServiceTransport(client, () => ({ serverId: client.serverId }));
		this.#onError = options.onError ?? (() => {});
		this.#connectionAttempt = client.connectionState === "connecting" ? 1 : 0;
		const connectionState = replicatedState<ServerConnectionState>(
			toServerConnectionState(client, this.#connectionAttempt),
		);
		this.connection = connectionState;
		this.#removeConnectionListener = client.onConnectionStateChange(({ state, error }) => {
			if (state === "connecting") this.#connectionAttempt += 1;
			publishReplacement(
				connectionState,
				toServerConnectionState(client, this.#connectionAttempt, error),
				BACKGROUND_CONTEXT,
			);
			this.#transition = this.#transition
				.then(async () => {
					const results = await Promise.allSettled(
						[...this.#bindings].map((binding) => binding.updateBound(state === "connected", BACKGROUND_CONTEXT)),
					);
					const failures = results.filter(
						(result): result is PromiseRejectedResult => result.status === "rejected",
					);
					if (failures.length > 0) throw new AggregateError(failures.map(({ reason }) => reason));
				})
				.catch((transitionError: unknown) => this.#onError(toError(transitionError)));
		});
	}

	catalogue(context: Context) {
		return this.#client.serviceCatalogue({ serverId: this.#client.serverId }, context.abortSignal);
	}

	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices {
		if (this.#disposed) throw new Error("Server service source is disposed");
		let binding!: RoutedServiceBinding;
		binding = new RoutedServiceBinding({
			services: options.services,
			transport: this.#transport,
			getBound: () => this.#client.connected,
			assertAccess: options.assertAccess,
			onError: options.onError,
			remove: () => this.#bindings.delete(binding),
		});
		this.#bindings.add(binding);
		return binding;
	}

	async dispose(context: Context): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#removeConnectionListener();
		await this.#transition;
		const bindings = [...this.#bindings];
		this.#bindings.clear();
		const results = await Promise.allSettled(bindings.map((binding) => binding.dispose(context)));
		throwFailures(results, "Failed to dispose server service source");
	}
}

class SessionServiceSourceImpl implements SessionServiceSource {
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	readonly #client: Client;
	readonly #transport: RemoteServiceTransport;
	readonly #attachmentState: MutableReplicatedState<SessionAttachmentState>;
	readonly #bindings = new Set<RoutedServiceBinding>();
	readonly #removeAttachmentListener: () => void;
	readonly #onError: (error: Error) => void;
	readonly #transitions = new Set<Promise<void>>();
	#catalogue: readonly ServiceCatalogueEntry[] | undefined;
	#attachmentRevision = 0;
	#disposed = false;

	get acceptsUnavailableServices(): boolean {
		return this.#client.attachment === undefined && this.#catalogue === undefined;
	}

	constructor(client: Client, options: ServiceSourceOptions) {
		this.#client = client;
		this.#transport = createClientServiceTransport(client, () => client.attachment);
		this.#onError = options.onError ?? (() => {});
		this.#attachmentState = replicatedState<SessionAttachmentState>(
			client.attachment === undefined
				? { status: "detached" }
				: { status: "attaching", sessionId: client.attachment.sessionId },
		);
		this.attachment = this.#attachmentState;
		this.#removeAttachmentListener = client.onAttachmentChange((attachment) => {
			const revision = ++this.#attachmentRevision;
			if (attachment !== undefined) {
				publishReplacement(
					this.#attachmentState,
					{ status: "attaching", sessionId: attachment.sessionId },
					BACKGROUND_CONTEXT,
				);
				void this.#client.serviceCatalogue(attachment).then(
					(catalogue) => {
						if (this.#attachmentRevision === revision && sameAttachment(this.#client.attachment, attachment)) {
							this.#catalogue = catalogue;
						}
					},
					(error: unknown) => this.#onError(toError(error)),
				);
			}
			const transition = this.#rebind(attachment !== undefined, BACKGROUND_CONTEXT);
			this.#transitions.add(transition);
			void transition.then(
				() => {
					this.#transitions.delete(transition);
					if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment))
						return;
					publishReplacement(
						this.#attachmentState,
						attachment === undefined
							? { status: "detached" }
							: { status: "attached", sessionId: attachment.sessionId },
						BACKGROUND_CONTEXT,
					);
				},
				(error: unknown) => {
					this.#transitions.delete(transition);
					if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment))
						return;
					publishReplacement(
						this.#attachmentState,
						attachment === undefined
							? { status: "detached" }
							: { status: "degraded", sessionId: attachment.sessionId },
						BACKGROUND_CONTEXT,
					);
					this.#onError(toError(error));
				},
			);
		});
	}

	async catalogue(context: Context): Promise<readonly ServiceCatalogueEntry[]> {
		const target = this.#client.attachment;
		if (target === undefined) return this.#catalogue ?? [];
		const catalogue = await this.#client.serviceCatalogue(target, context.abortSignal);
		this.#catalogue = catalogue;
		return catalogue;
	}

	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices {
		if (this.#disposed) throw new Error("Session service source is disposed");
		let binding!: RoutedServiceBinding;
		binding = new RoutedServiceBinding({
			services: options.services,
			transport: this.#transport,
			getBound: () => this.#client.attachment !== undefined,
			onActivate: async (context) => {
				const attachment = this.#client.attachment;
				if (attachment === undefined) await this.#whenDetached(this.#attachmentRevision, context);
				else await this.#whenAttached(attachment, this.#attachmentRevision, context);
			},
			assertAccess: options.assertAccess,
			onError: options.onError,
			remove: () => this.#bindings.delete(binding),
		});
		this.#bindings.add(binding);
		return binding;
	}

	async whenAttached(sessionId: string, context: Context): Promise<void> {
		const attachment = this.#client.attachment;
		if (attachment === undefined || attachment.sessionId !== sessionId) {
			throw new Error(`Session ${sessionId} is not the current attachment`);
		}
		await this.#whenAttached(attachment, this.#attachmentRevision, context);
	}

	async whenDetached(context: Context): Promise<void> {
		if (this.#client.attachment !== undefined) throw new Error("A Session is still attached");
		await this.#whenDetached(this.#attachmentRevision, context);
	}

	async dispose(context: Context): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#removeAttachmentListener();
		await Promise.allSettled(this.#transitions);
		const bindings = [...this.#bindings];
		this.#bindings.clear();
		const results = await Promise.allSettled(bindings.map((binding) => binding.dispose(context)));
		throwFailures(results, "Failed to dispose Session service source");
	}

	async #rebind(bound: boolean, context: Context): Promise<void> {
		const results = await Promise.allSettled(
			[...this.#bindings].map((binding) => binding.updateBound(bound, context)),
		);
		throwFailures(results, "Failed to rebind Session services");
	}

	async #whenAttached(attachment: SessionTarget, revision: number, context: Context): Promise<void> {
		try {
			await Promise.all([...this.#bindings].map((binding) => binding.serviceReady(context)));
		} catch (error) {
			if (this.#attachmentRevision === revision && sameAttachment(this.#client.attachment, attachment)) {
				publishReplacement(this.#attachmentState, { status: "degraded", sessionId: attachment.sessionId }, context);
			}
			throw error;
		}
		if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment)) {
			throw new Error(`Session ${attachment.sessionId} was replaced while attaching`);
		}
		const state = this.#attachmentState.value;
		if (state.status !== "attached" || state.sessionId !== attachment.sessionId) {
			publishReplacement(this.#attachmentState, { status: "attached", sessionId: attachment.sessionId }, context);
		}
	}

	async #whenDetached(revision: number, context: Context): Promise<void> {
		await Promise.all([...this.#bindings].map((binding) => binding.serviceReady(context)));
		if (this.#attachmentRevision !== revision || this.#client.attachment !== undefined) {
			throw new Error("The Session attachment changed while detaching");
		}
		if (this.#attachmentState.value.status !== "detached") {
			publishReplacement(this.#attachmentState, { status: "detached" }, context);
		}
	}
}

/** Create the server-scoped remote service source for one presentation client. */
export function createServerServiceSource(client: Client, options: ServiceSourceOptions = {}): ServerServiceSource {
	return new ServerServiceSourceImpl(client, options);
}

/** Create the selected-Session remote service source for one presentation client. */
export function createSessionServiceSource(client: Client, options: ServiceSourceOptions = {}): SessionServiceSource {
	return new SessionServiceSourceImpl(client, options);
}

function publishReplacement<T extends object>(state: MutableReplicatedState<T>, value: T, context: Context): void {
	const target = state.state as Record<string, unknown>;
	const replacement = value as Record<string, unknown>;
	for (const key of Object.keys(target)) {
		if (!Object.hasOwn(replacement, key)) delete target[key];
	}
	Object.assign(target, replacement);
	state.publish(context);
}

function toServerConnectionState(client: Client, attempt: number, error?: Error): ServerConnectionState {
	const since = new Date().toISOString();
	switch (client.connectionState) {
		case "connecting":
			return { status: "connecting", attempt };
		case "connected":
			return { status: "connected", since };
		case "disconnected":
			return {
				status: "disconnected",
				since,
				reason: error?.message ?? "Client is disconnected",
				retryAt: null,
			};
	}
}

function sameAttachment(left: SessionTarget | undefined, right: SessionTarget | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return (
		left.serverId === right.serverId && left.sessionId === right.sessionId && left.attachmentId === right.attachmentId
	);
}

function throwFailures(results: readonly PromiseSettledResult<unknown>[], message: string): void {
	const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
