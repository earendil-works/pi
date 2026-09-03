import { basename } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client, ServerError } from "@earendil-works/pi-client";
import { createUnixTransportFactory, discoverUnixServers, type UnixServerRoute } from "@earendil-works/pi-client/unix";
import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { RadiusRelayAuthResolver } from "./radius-auth.ts";
import { createRadiusClientTransportFactory, RadiusClientReconnect } from "./radius-relay.ts";
import { activateServer, ENV_SERVER_ID, resolveServerDirectory, resolveSessionDirectory } from "./server.ts";
import { AgentController } from "./services/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type ServerServiceSource,
	type SessionServiceSource,
} from "./services/connection.ts";
import { Models } from "./services/models.ts";
import { PresentationPlugins } from "./services/plugins.ts";
import { SessionDirectory, SessionManagement } from "./services/sessions.ts";
import { Transcript } from "./services/transcript.ts";

export type ClientRuntimeRoute =
	| ({ readonly transport: "unix" } & UnixServerRoute)
	| { readonly transport: "radius"; readonly serverId: ServerId };

export interface ClientRuntimeServer {
	readonly route: ClientRuntimeRoute;
	readonly client: Client;
	readonly server: ServerServiceSource;
	readonly session: SessionServiceSource;
}

export interface ActivatedClientRuntimeServer extends ClientRuntimeServer {
	readonly directory: SessionDirectory;
	readonly management: SessionManagement;
	readonly plugins: PresentationPlugins;
	readonly models: Models;
	readonly agent: AgentController;
	readonly transcript: Transcript;
}

export interface ClientRuntime {
	readonly servers: readonly ClientRuntimeServer[];
	dispose(): Promise<void>;
}

export interface OpenClientRuntimeOptions {
	/** Directory searched when --connect is omitted. Defaults to PI_SERVER_DIR or ~/.pi/server. */
	readonly directory?: string;
}

/** Open live server/session service namespaces for one experimental presentation. */
export async function openClientRuntime(
	command: ClientCommand,
	options: OpenClientRuntimeOptions = {},
): Promise<ClientRuntime> {
	if (command.auth !== undefined && command.connect?.transport !== "radius") {
		throw new Error("Authentication is only supported for experimental Radius connections");
	}
	if (command.provider !== undefined && command.model === undefined) {
		throw new Error("Server model provider requires a model");
	}
	if (command.connect && command.model !== undefined) {
		throw new Error("Model selection is only valid when automatically activating a new server");
	}
	if (command.connect?.transport === "radius" && command.pluginPackages !== undefined) {
		throw new Error("Plugin package paths can only be configured on a local Unix server");
	}
	const directory = resolveServerDirectory(options.directory);
	let routes: ClientRuntimeRoute[];
	let activatedClient: Client | undefined;
	if (command.connect) {
		routes = [
			command.connect.transport === "radius"
				? { transport: "radius", serverId: command.connect.serverId }
				: { transport: "unix", ...routeFromExplicitPath(command.connect.path) },
		];
	} else {
		routes = (await discoverUnixServers({ directory })).map((route) => ({ transport: "unix", ...route }));
		if (routes.length > 0 && command.model !== undefined) {
			throw new Error("Model selection is only valid when automatically activating a new server");
		}
		if (routes.length === 0) {
			const activated = await activateServer({
				directory,
				requestedServerId: process.env[ENV_SERVER_ID],
				sessionDir: resolveSessionDirectory(),
				provider: command.provider,
				model: command.model,
			});
			routes = [{ transport: "unix", ...activated.route }];
			activatedClient = activated.client;
		}
	}
	if (command.pluginPackages !== undefined && routes.length !== 1) {
		throw new Error("Plugin selection requires exactly one local server");
	}

	const clients: Client[] = [];
	const reconnectors: RadiusClientReconnect[] = [];
	const serviceSources: Array<ServerServiceSource | SessionServiceSource> = [];
	const servers: ClientRuntimeServer[] = [];
	let disposed = false;
	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		const reconnectResults = await Promise.allSettled(reconnectors.map((reconnector) => reconnector.dispose()));
		const sourceResults = await Promise.allSettled(
			serviceSources.map((source) => source.dispose(BACKGROUND_CONTEXT)),
		);
		const clientResults = await Promise.allSettled(clients.map((client) => client.dispose()));
		const errors = [...reconnectResults, ...sourceResults, ...clientResults].flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose experimental client runtime");
	};

	try {
		for (const route of routes) {
			let client = activatedClient;
			if (client === undefined) {
				try {
					client = await Client.connect({
						serverId: route.serverId,
						transportFactory:
							route.transport === "unix"
								? createUnixTransportFactory({ path: route.path })
								: createRadiusClientTransportFactory({
										serverId: route.serverId,
										auth: new RadiusRelayAuthResolver(command.auth),
									}),
					});
				} catch (error) {
					if (
						command.connect !== undefined ||
						route.transport !== "unix" ||
						!(error instanceof ServerError) ||
						error.code !== "version"
					) {
						throw error;
					}
					client = (
						await activateServer({
							directory,
							requestedServerId: route.serverId,
							sessionDir: resolveSessionDirectory(),
						})
					).client;
				}
			}
			activatedClient = undefined;
			clients.push(client);
			const server = createServerServiceSource(client);
			serviceSources.push(server);
			if (route.transport === "radius") {
				const reconnectServices = server.open({
					services: [SessionManagement],
					assertAccess() {},
					onError() {},
				});
				const reconnectManagement = reconnectServices.use(SessionManagement);
				reconnectors.push(
					new RadiusClientReconnect(client, async (sessionId) => {
						await reconnectServices.ready(BACKGROUND_CONTEXT);
						await reconnectManagement.attach(sessionId, BACKGROUND_CONTEXT);
					}),
				);
			}
			const session = createSessionServiceSource(client);
			serviceSources.push(session);
			servers.push({ route, client, server, session });
		}
		return { servers, dispose };
	} catch (error) {
		try {
			await dispose();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Experimental client startup and cleanup failed");
		}
		throw error;
	}
}

/** Acquire and connect the built-in service facades used by the non-interactive client. */
export async function activateBuiltinClientServices(
	server: ClientRuntimeServer,
): Promise<ActivatedClientRuntimeServer> {
	const serverServices = server.server.open({
		services: [SessionDirectory, SessionManagement, PresentationPlugins],
		assertAccess() {},
		onError() {},
	});
	const sessionServices = server.session.open({
		services: [Models, AgentController, Transcript],
		assertAccess() {},
		onError() {},
	});
	const directory = serverServices.use(SessionDirectory);
	const remoteManagement = serverServices.use(SessionManagement);
	const management: SessionManagement = {
		create: (options, context) => remoteManagement.create(options, context),
		async remove(sessionId, context) {
			const removesCurrentAttachment = server.client.attachment?.sessionId === sessionId;
			await remoteManagement.remove(sessionId, context);
			if (removesCurrentAttachment) await server.session.whenDetached(context);
		},
		async attach(sessionId, context) {
			await remoteManagement.attach(sessionId, context);
			await server.session.whenAttached(sessionId, context);
		},
		async detach(context) {
			await remoteManagement.detach(context);
			await server.session.whenDetached(context);
		},
	};
	const plugins = serverServices.use(PresentationPlugins);
	const models = sessionServices.use(Models);
	const agent = sessionServices.use(AgentController);
	const transcript = sessionServices.use(Transcript);
	await Promise.all([serverServices.ready(BACKGROUND_CONTEXT), sessionServices.ready(BACKGROUND_CONTEXT)]);
	return { ...server, directory, management, plugins, models, agent, transcript };
}

function routeFromExplicitPath(path: string): UnixServerRoute {
	const name = basename(path);
	const serverId = name.endsWith(".sock") ? name.slice(0, -".sock".length) : "";
	if (!isServerId(serverId)) throw new Error("--connect path must end with <uuidv4-server-id>.sock");
	return { serverId, path };
}
