import {
	type EventEnvelope,
	type ModelMetadata,
	PROTOCOL_VERSION,
	type ServerSnapshot,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";
import type { ConnectionState } from "./connection.ts";
import type { PiServerService } from "./types.ts";

interface ServerSnapshotPublisherOptions {
	serverId: string;
	service: PiServerService;
	connections: Set<ConnectionState>;
	isClosing: () => boolean;
	listSessions: () => Promise<SessionMetadata[]>;
	sendMessage: (connection: ConnectionState, message: EventEnvelope) => Promise<boolean>;
	reportError: (error: unknown) => void;
}

export class ServerSnapshotPublisher {
	private readonly options: ServerSnapshotPublisherOptions;
	private revision = 0;
	private broadcastQueue: Promise<void> = Promise.resolve();

	constructor(options: ServerSnapshotPublisherOptions) {
		this.options = options;
	}

	get currentRevision(): number {
		return this.revision;
	}

	async get(models?: ModelMetadata[]): Promise<ServerSnapshot> {
		return {
			serverId: this.options.serverId,
			protocolVersion: PROTOCOL_VERSION,
			revision: this.revision,
			sessions: await this.options.listSessions(),
			models: models ?? (await this.options.service.listModels()),
		};
	}

	broadcast(): Promise<void> {
		const broadcast = this.broadcastQueue.then(() => this.performBroadcast());
		this.broadcastQueue = broadcast.catch((error: unknown) => this.options.reportError(error));
		return broadcast;
	}

	private async performBroadcast(): Promise<void> {
		const readyConnections = [...this.options.connections].filter(
			(connection) => connection.stage === "ready" && !connection.disconnected,
		);
		if (readyConnections.length === 0 || this.options.isClosing()) return;
		const revision = ++this.revision;
		const models = await this.options.service.listModels();
		const current = await this.get(models);
		const snapshot: ServerSnapshot = { ...current, revision };
		const envelope: EventEnvelope = { type: "event", event: { type: "server_snapshot", snapshot } };
		for (const connection of readyConnections) await this.options.sendMessage(connection, envelope);
	}
}
