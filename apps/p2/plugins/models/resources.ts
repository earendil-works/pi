import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	type MobileSettings,
	normalizePath,
	Observer,
	optionalText,
	parseSettings,
	saveSettings,
} from "@p2/app/v1/node";
import type { ServerResourceOptions } from "@p2/app/v1/server";
import { FileCredentials } from "./credentials.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore } from "./model-store.ts";
import { createP2Models } from "./models.ts";
import { applyModelConfig } from "./provider-config.ts";

export type ResourceError = { resource: "settings" | "models" | "credentials"; message: string };
export type ResourceSnapshot = {
	version: number;
	settings: MobileSettings;
	credentials: CredentialInfo[];
	providers: {
		id: string;
		name: string;
		authMethods: ("api_key" | "oauth")[];
		loginMethods: { type: "api_key" | "oauth"; label: string }[];
	}[];
	models: { provider: string; modelId: string; name: string; thinkingLevels: string[]; contextWindow: number }[];
	errors: ResourceError[];
};
export type ResourceOptions = ServerResourceOptions & {
	directory: string;
	fake?: boolean;
};

/** Without a working watcher (an error), the configuration files are read this often. */
const FALLBACK_MS = 2000;

// One instance per process, never a server-owned reload coordinator. A watch on the configuration files
// (creation, deletion, in-place writes, atomic renames) triggers loads; nothing polls while it works.
export class Resources {
	readonly directory: string;
	readonly credentials: FileCredentials;
	readonly modelStore: FileModelsStore;
	readonly models: Models;
	private readonly options: ResourceOptions;
	private current: MutableModels;
	private settingsValue: MobileSettings = {};
	private readonly errors = new Map<ResourceError["resource"], string>();
	private readonly fingerprints = new Map<string, string>();
	/** Resources that failed once and are read again before their error is reported. */
	private readonly unconfirmed = new Set<string>();
	private readonly controller = new AbortController();
	private readonly listeners = new Set<() => void>();
	private readonly writes = new Set<Promise<void>>();
	private readonly observer: Observer;
	private closed = false;
	private revision = 0;

	constructor(options: ResourceOptions) {
		this.options = options;
		this.directory = normalizePath(options.directory);
		this.credentials = new FileCredentials(join(this.directory, "auth.json"));
		this.modelStore = new FileModelsStore(join(this.directory, "models-store.json"));
		this.current = this.baseModels();
		const directory = this.directory;
		this.observer = new Observer(
			[
				{
					env: new NodeExecutionEnv({ cwd: directory }),
					targets: () =>
						["settings.json", "models.json", "models-store.json", "auth.json"].map((name) => ({
							path: join(directory, name),
						})),
				},
			],
			(retrying) => this.load(retrying),
			FALLBACK_MS,
		);
		this.models = new Proxy(this.current, {
			get: (_target, key) => {
				const value: unknown = Reflect.get(this.current, key, this.current);
				// Bind at invocation lookup to an immutable configuration generation.
				// A stream waiting on auth must not switch providers during a reload.
				return typeof value === "function" ? value.bind(this.current) : value;
			},
		});
	}

	private baseModels(credentials: CredentialStore = this.credentials): MutableModels {
		return (
			this.options.createModels?.(credentials, this.modelStore) ??
			createP2Models(this.options.fake ?? false, { credentials, modelsStore: this.modelStore })
		);
	}

	get settings(): MobileSettings {
		return structuredClone(this.settingsValue);
	}
	get resourceErrors(): ResourceError[] {
		return [...this.errors].map(([resource, message]) => ({ resource, message }));
	}

	// Durable reads settings at each decision. Requests/tool invocations already
	// in progress keep the decisions/code they took; later phases read new values.
	harnessSettings(): HarnessSettings {
		const resources = this;
		return {
			get stream() {
				return resources.settings.stream;
			},
			get retry() {
				return resources.settings.retry;
			},
			get compaction() {
				return resources.settings.compaction;
			},
			get toolExecution() {
				return resources.settings.toolExecution;
			},
			get steeringMode() {
				return resources.settings.steeringMode;
			},
			get followUpMode() {
				return resources.settings.followUpMode;
			},
		};
	}

	/** Watch the configuration files and load them; resolves after the first load. */
	start(): Promise<void> {
		return this.observer.start();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private changed(resource: ResourceError["resource"], fingerprint: string): boolean {
		if (
			this.fingerprints.get(resource) === fingerprint &&
			!this.errors.has(resource) &&
			!this.unconfirmed.has(resource)
		)
			return false;
		this.fingerprints.set(resource, fingerprint);
		return true;
	}

	/** Load the configuration files again now; resolves once loaded. */
	reload(): Promise<void> {
		return this.observer.reload();
	}

	/** Returns whether a resource failed for the first time and should be read once more before reporting it. */
	private async load(retrying: boolean): Promise<boolean> {
		let changed = false;
		let retry = false;
		const attempt = async (resource: ResourceError["resource"], action: () => Promise<void>) => {
			try {
				await action();
				this.unconfirmed.delete(resource);
			} catch {
				// An editor's save may have been caught half-way: read once more before reporting it.
				if (!retrying && !this.unconfirmed.has(resource)) {
					this.unconfirmed.add(resource);
					retry = true;
					return;
				}
				this.unconfirmed.delete(resource);
				const message = `Could not load ${resource} resources; keeping last valid state`;
				if (this.errors.get(resource) !== message) {
					this.errors.set(resource, message);
					changed = true;
				}
			}
		};
		await attempt("settings", async () => {
			const content = (await optionalText(join(this.directory, "settings.json"))) ?? "{}";
			if (!this.changed("settings", content)) return;
			const settings = parseSettings(content);
			this.settingsValue = settings;
			this.errors.delete("settings");
			changed = true;
		});
		await attempt("models", async () => {
			const path = join(this.directory, "models.json");
			const content = (await optionalText(path)) ?? "";
			if (!this.changed("models", `${content}\n${this.modelStore.fingerprint()}`)) return;
			const config = await ModelConfig.load(path);
			if (config.getError()) throw new Error("Invalid models configuration");
			let restoring = true;
			const relay: CredentialStore = {
				read: (id, options) =>
					restoring ? Promise.resolve(this.credentials.storedSnapshot(id)) : this.credentials.read(id, options),
				list: (options) => this.credentials.list(options),
				modify: (id, update, options) => this.credentials.modify(id, update, options),
				delete: (id, options) => this.credentials.delete(id, options),
			};
			const next = this.baseModels(relay);
			const restored = await next.refresh({ allowNetwork: false, signal: this.controller.signal });
			if (restored.errors.size) throw new Error("Could not restore cached model catalogs");
			restoring = false;
			applyModelConfig(next, config); // Build/validate completely before publishing.
			this.current = next;
			this.errors.delete("models");
			changed = true;
		});
		await attempt("credentials", async () => {
			let fingerprint = "missing";
			try {
				const info = await stat(join(this.directory, "auth.json"), { bigint: true });
				fingerprint = `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
			}
			if (!this.changed("credentials", fingerprint)) return;
			await this.credentials.reload({ signal: this.controller.signal });
			if (this.credentials.revision) this.fingerprints.set("credentials", this.credentials.revision);
			this.errors.delete("credentials");
			changed = true;
		});
		if (changed && !this.closed) {
			this.revision++;
			for (const listener of this.listeners) listener();
		}
		return retry;
	}

	snapshot(): ResourceSnapshot {
		return {
			version: this.revision,
			settings: this.settings,
			credentials: this.credentials.metadata(),
			errors: this.resourceErrors,
			providers: this.models.getProviders().map((provider) => ({
				id: provider.id,
				name: provider.name,
				loginMethods: [
					...(provider.auth.apiKey?.login ? [{ type: "api_key" as const, label: provider.auth.apiKey.name }] : []),
					...(provider.auth.oauth
						? [{ type: "oauth" as const, label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name }]
						: []),
				],
				authMethods: [
					...(provider.auth.apiKey ? ["api_key" as const] : []),
					...(provider.auth.oauth ? ["oauth" as const] : []),
				],
			})),
			models: this.models.getModels().map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				thinkingLevels: getSupportedThinkingLevels(model),
				contextWindow: model.contextWindow,
			})),
		};
	}

	publish(): void {
		if (this.closed) return;
		this.revision++;
		for (const listener of this.listeners) listener();
	}

	async refreshModels(providerId: string, signal: AbortSignal): Promise<void> {
		const result = await this.models.refresh({ providers: [providerId], allowNetwork: true, force: true, signal });
		this.publish();
		if (result.aborted) signal.throwIfAborted();
		if (result.errors.size) throw new Error("Could not refresh provider models");
	}

	async saveSettings(value: unknown): Promise<void> {
		const operation = saveSettings(join(this.directory, "settings.json"), value, { signal: this.controller.signal });
		this.writes.add(operation);
		try {
			await operation;
			await this.reload();
		} finally {
			this.writes.delete(operation);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.controller.abort();
		await this.observer.close();
		await Promise.allSettled([...this.writes]);
		await this.credentials.close();
		await this.modelStore.close();
		this.listeners.clear();
	}
}
