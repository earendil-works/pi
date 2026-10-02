import type { Context, JsonValue, ServiceCall } from "@earendil-works/chord";
import { SessionNotFoundError } from "../errors.ts";
import type { RoutedServerServiceHost, RoutedSessionHandle, ServerHost, SessionMetadata } from "../types.ts";

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
	readonly metadata: SessionMetadata;
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

	constructor(metadata: SessionMetadata) {
		this.metadata = metadata;
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

	async close(_context: Context): Promise<void> {
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
		this.closed.resolve(undefined);
		this.#termination.resolve(undefined);
	}

	async terminate(error: Error): Promise<void> {
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
	readonly sessions = new Map<string, SessionMetadata>();
	readonly harnesses = new Map<string, TestHarness[]>();
	openSessionCount = 0;
	nextOpenSessionError?: Error;
	nextHarnessCloseError?: Error;
	private nextOpenSessionGate?: OpenGate;

	async resolveSession(sessionId: string, _context: Context): Promise<SessionMetadata> {
		const metadata = this.sessions.get(sessionId);
		if (!metadata) throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
		return metadata;
	}

	async openSession(metadata: SessionMetadata, _context: Context): Promise<RoutedSessionHandle> {
		this.openSessionCount += 1;
		const gate = this.nextOpenSessionGate;
		if (gate) {
			this.nextOpenSessionGate = undefined;
			gate.entered.resolve(undefined);
			await gate.release.promise;
		}
		if (!this.sessions.has(metadata.id)) throw new SessionNotFoundError(`Unknown session: ${metadata.id}`);
		if (this.nextOpenSessionError) {
			const error = this.nextOpenSessionError;
			this.nextOpenSessionError = undefined;
			throw error;
		}
		const harness = new TestHarness(metadata);
		if (this.nextHarnessCloseError) {
			harness.failClose = this.nextHarnessCloseError;
			this.nextHarnessCloseError = undefined;
		}
		const harnesses = this.harnesses.get(metadata.id) ?? [];
		harnesses.push(harness);
		this.harnesses.set(metadata.id, harnesses);
		return harness;
	}

	async seed(id = "session-1"): Promise<SessionMetadata> {
		const metadata: SessionMetadata = { id };
		this.sessions.set(id, metadata);
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
