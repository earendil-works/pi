import type { JsonValue, ServiceCall } from "@earendil-works/chord";
import type { Context, Session, SessionMetadata } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { SessionAmbiguousError, SessionNotFoundError } from "../errors.ts";
import type { RoutedServerServiceHost, RoutedSessionHandle, ServerHost } from "../types.ts";

export class Deferred<T> {
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T) => void;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		this.resolvePromise(value);
	}
}

interface OpenGate {
	entered: Deferred<void>;
	release: Deferred<void>;
}

export class TestHarness {
	readonly session: Session;
	readonly closed = new Deferred<void>();
	readonly #termination = new Deferred<Error | undefined>();
	readonly terminated = this.#termination.promise;
	attachedClients = 0;
	attachmentReleaseCount = 0;
	closeCount = 0;
	readonly serviceCalls: ServiceCall[] = [];
	failAttachmentRelease?: Error;
	failClose?: Error;
	nextServiceError?: Error;
	nextServiceResult: JsonValue | undefined = { ok: true };
	private nextCloseGate?: OpenGate;
	private nextServiceGate?: OpenGate;

	constructor(session: Session) {
		this.session = session;
	}

	attachClient(_context: Context): {
		invokeService: TestHarness["invokeService"];
		release(context: Context): void;
	} {
		this.attachedClients += 1;
		let released = false;
		return {
			invokeService: (call) => this.invokeService(call),
			release: (_context) => {
				if (released) return;
				this.attachmentReleaseCount += 1;
				if (this.failAttachmentRelease) throw this.failAttachmentRelease;
				released = true;
				this.attachedClients -= 1;
			},
		};
	}

	async invokeService(call: ServiceCall): Promise<JsonValue | undefined> {
		this.serviceCalls.push(call);
		if (this.nextServiceError) {
			const error = this.nextServiceError;
			this.nextServiceError = undefined;
			throw error;
		}
		const gate = this.nextServiceGate;
		if (gate) {
			this.nextServiceGate = undefined;
			gate.entered.resolve(undefined);
			await gate.release.promise;
		}
		const result = this.nextServiceResult;
		this.nextServiceResult = { ok: true };
		return result;
	}

	async close(context: Context): Promise<void> {
		this.closeCount += 1;
		const gate = this.nextCloseGate;
		if (gate) {
			this.nextCloseGate = undefined;
			gate.entered.resolve(undefined);
			await gate.release.promise;
		}
		if (this.failClose) {
			const error = this.failClose;
			this.failClose = undefined;
			throw error;
		}
		await this.session.close(context);
		this.closed.resolve(undefined);
		this.#termination.resolve(undefined);
	}

	async terminate(error: Error): Promise<void> {
		await this.session.close(BACKGROUND_CONTEXT);
		this.#termination.resolve(error);
	}

	gateNextClose(): OpenGate {
		const gate = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextCloseGate = gate;
		return gate;
	}

	gateNextServiceCall(): OpenGate {
		const gate = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextServiceGate = gate;
		return gate;
	}
}

export function createTestServerServices(): RoutedServerServiceHost {
	return {
		attachClient(presentation) {
			return {
				async invokeService(call, _publish, context) {
					if (
						call.instance === undefined &&
						call.serviceId === "pi.session-management" &&
						call.member === "attach" &&
						call.args.length === 1 &&
						typeof call.args[0] === "string"
					) {
						await presentation.attachSession(call.args[0], context);
						return null;
					}
					if (
						call.instance === undefined &&
						call.serviceId === "pi.session-management" &&
						call.member === "detach" &&
						call.args.length === 0
					) {
						await presentation.detachSession(context);
						return null;
					}
					throw new Error(`Unsupported test server service ${call.serviceId}.${call.member}`);
				},
				release() {},
			};
		},
	};
}

export class TestServerHost implements ServerHost {
	readonly serverServices = createTestServerServices();
	readonly repo = new MemorySessionRepo({ now: () => 1 });
	readonly harnesses = new Map<string, TestHarness[]>();
	openSessionCount = 0;
	nextOpenSessionError?: Error;
	nextHarnessCloseError?: Error;
	private nextOpenSessionGate?: OpenGate;

	async resolveSession(sessionId: string, context: Context): Promise<SessionMetadata> {
		const matches = (await this.repo.list(undefined, context)).filter(({ id }) => id === sessionId);
		if (matches.length === 0) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		if (matches.length > 1) throw new SessionAmbiguousError();
		return matches[0]!;
	}

	async openSession(metadata: SessionMetadata, context: Context): Promise<RoutedSessionHandle> {
		this.openSessionCount += 1;
		const gate = this.nextOpenSessionGate;
		if (gate) {
			this.nextOpenSessionGate = undefined;
			gate.entered.resolve(undefined);
			await gate.release.promise;
		}
		const session = await this.repo.open(metadata, context);
		try {
			if (this.nextOpenSessionError) {
				const error = this.nextOpenSessionError;
				this.nextOpenSessionError = undefined;
				throw error;
			}
			const harness = new TestHarness(session);
			if (this.nextHarnessCloseError) {
				harness.failClose = this.nextHarnessCloseError;
				this.nextHarnessCloseError = undefined;
			}
			const harnesses = this.harnesses.get(metadata.id) ?? [];
			harnesses.push(harness);
			this.harnesses.set(metadata.id, harnesses);
			return harness;
		} catch (error) {
			await session.close(context);
			throw error;
		}
	}

	async seed(id = "session-1", parentSessionId?: string): Promise<SessionMetadata> {
		const session = await this.repo.create({ id, parentSessionId }, BACKGROUND_CONTEXT);
		const metadata = session.metadata;
		await session.close(BACKGROUND_CONTEXT);
		return metadata;
	}

	gateNextOpenSession(): OpenGate {
		const gate = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextOpenSessionGate = gate;
		return gate;
	}

	latestHarness(id: string): TestHarness {
		const harnesses = this.harnesses.get(id);
		if (!harnesses?.length) throw new Error(`No harness for ${id}`);
		return harnesses.at(-1)!;
	}
}
