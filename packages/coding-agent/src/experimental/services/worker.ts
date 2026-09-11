import {
	type Context,
	createFacetHost,
	createRemoteServiceEndpoint,
	createStaticFacetLoader,
	defineFacet,
	type FacetHost,
	type FacetLoader,
	type JsonValue,
	type RemoteServiceEndpoint,
	type ServiceCall,
	type ServiceProviderUpdate,
} from "@earendil-works/chord";
import type { AgentHarness, AgentLane } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { AgentController } from "./agent-controller.ts";
import { createAgentController } from "./agent-controller-provider.ts";
import { createModelsServiceFacet } from "./models-provider.ts";
import { SessionPlugins } from "./plugins.ts";
import { createTranscriptServiceFacet } from "./transcript-provider.ts";

export interface SessionWorkerRuntime {
	readonly harness: AgentHarness;
	readonly lane?: AgentLane;
	readonly modelRuntime?: ModelRuntime;
	readonly settingsManager?: SettingsManager;
	readonly facetLoader?: FacetLoader;
}

export interface WorkerServiceScope {
	readonly serverConnectionId: string;
	readonly attachmentId: string;
}

interface ScopedServiceEndpoint {
	readonly scope: WorkerServiceScope;
	readonly endpoint: RemoteServiceEndpoint;
}

export interface SessionWorkerServices {
	invoke(call: ServiceCall, scope: WorkerServiceScope, context: Context): Promise<JsonValue | undefined>;
	removeSubscriptions(matches: (scope: WorkerServiceScope) => boolean): void;
	dispose(): Promise<void>;
}

export async function createSessionWorkerServices(options: {
	readonly lane: AgentLane;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly settingsManager?: SettingsManager;
	readonly facetLoader?: FacetLoader;
	publish(scope: WorkerServiceScope, subscriptionId: string, update: ServiceProviderUpdate): Promise<void>;
}): Promise<SessionWorkerServices> {
	const agentControllerRuntimeFacet = defineFacet({
		id: "@pi/agent-controller-runtime",
		setup(env) {
			env.provide(AgentController, createAgentController(options.lane));
		},
	});
	let reloadPlugins = (): Promise<void> => Promise.reject(new Error("Session plugins are not ready"));
	const pluginRuntimeFacet = defineFacet({
		id: "@pi/session-plugins-runtime",
		setup(env) {
			env.provide(SessionPlugins, { reload: () => reloadPlugins() });
		},
	});
	const builtins = await createStaticFacetLoader([
		agentControllerRuntimeFacet,
		pluginRuntimeFacet,
		createModelsServiceFacet(options),
		createTranscriptServiceFacet(options.lane),
	]).load();
	const pluginLoader = options.facetLoader ?? createStaticFacetLoader([]);
	let loadedPlugins = await pluginLoader.load();
	let facetHost: FacetHost;
	try {
		facetHost = await createFacetHost({ facets: [...builtins.facets, ...loadedPlugins.facets] });
	} catch (error) {
		const cleanup = await Promise.allSettled([loadedPlugins.dispose(), builtins.dispose()]);
		const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "Session facets failed to start and clean up");
		}
		throw error;
	}
	let reloadTail = Promise.resolve();
	reloadPlugins = () => {
		const operation = reloadTail.then(async () => {
			const candidate = await pluginLoader.load();
			try {
				await facetHost.reload(candidate.facets);
			} catch (error) {
				try {
					await candidate.dispose();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Session plugin reload and cleanup failed");
				}
				throw error;
			}
			const retired = loadedPlugins;
			loadedPlugins = candidate;
			await retired.dispose();
		});
		reloadTail = operation.catch(() => {});
		return operation;
	};
	const provider = facetHost.services;

	const endpoints = new Map<string, ScopedServiceEndpoint>();
	const removeSubscriptions = (matches: (scope: WorkerServiceScope) => boolean): void => {
		for (const [key, entry] of endpoints) {
			if (!matches(entry.scope)) continue;
			entry.endpoint.dispose();
			endpoints.delete(key);
		}
	};

	return {
		invoke(call, scope, context) {
			const key = serviceScopeKey(scope);
			let entry = endpoints.get(key);
			if (entry === undefined) {
				entry = { scope, endpoint: createRemoteServiceEndpoint(provider) };
				endpoints.set(key, entry);
			}
			return entry.endpoint.invoke(
				call,
				(subscriptionId, update) => options.publish(scope, subscriptionId, update),
				context,
			);
		},
		removeSubscriptions,
		async dispose() {
			removeSubscriptions(() => true);
			await reloadTail;
			const errors: unknown[] = [];
			try {
				await facetHost.dispose();
			} catch (error) {
				errors.push(error);
			}
			const results = await Promise.allSettled([loadedPlugins.dispose(), builtins.dispose()]);
			errors.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose Session facets");
		},
	};
}

function serviceScopeKey(scope: WorkerServiceScope): string {
	return `${scope.serverConnectionId}\0${scope.attachmentId}`;
}
