import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { formatBytes, LlamaClient, type LlamaModelInfo, normalizeLlamaServerUrl } from "./client.ts";
import { findHuggingFaceToken, HuggingFaceClient } from "./huggingface.ts";
import { createManagedLlama, huggingFaceCacheDir, type ManagedLlamaServerInfo } from "./managed.ts";
import { createLlamaProvider, LLAMA_MANAGED_MODE, LLAMA_MODE_ENV, LLAMA_PROVIDER_ID } from "./provider.ts";
import { type LlamaUi, runWithProgress, showLlamaUi } from "./ui.ts";

const LOG_TAIL_LINES = 30;

function modelIsLoaded(model: LlamaModelInfo): boolean {
	return model.status.value === "loaded" || model.status.value === "sleeping";
}

function isConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = `${error.name} ${error.message}`.toLowerCase();
	return message.includes("fetch failed") || message.includes("timeout") || message.includes("network");
}

function connectionErrorMessage(error: unknown): string {
	if (isConnectionError(error)) return "Could not connect to the server.";
	return error instanceof Error ? error.message : String(error);
}

function parseHuggingFaceModel(value: string): { repository: string; quantization?: string } {
	const colon = value.indexOf(":", value.indexOf("/") + 1);
	return colon < 0
		? { repository: value }
		: { repository: value.slice(0, colon), quantization: value.slice(colon + 1) };
}

function displayPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

async function readLogTail(path: string): Promise<string[]> {
	try {
		return (await readFile(path, "utf8")).trimEnd().split("\n").slice(-LOG_TAIL_LINES);
	} catch (error) {
		return [`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`];
	}
}

/** The `/llama` target: a fixed server URL, or the managed server that pi starts on demand. */
type LlamaTarget = { type: "connect"; client: LlamaClient } | { type: "managed" };

async function configuredTarget(ctx: ExtensionCommandContext): Promise<LlamaTarget | undefined> {
	const result = await ctx.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
	if (!result) {
		ctx.ui.notify(`Configure llama.cpp with /login ${LLAMA_PROVIDER_ID}`, "warning");
		return undefined;
	}
	if (result.env?.[LLAMA_MODE_ENV] === LLAMA_MANAGED_MODE) return { type: "managed" };
	const configuredUrl = result.env?.LLAMA_BASE_URL;
	const serverUrl = normalizeLlamaServerUrl(
		typeof configuredUrl === "string" && configuredUrl ? configuredUrl : (result.auth.baseUrl ?? ""),
	);
	return { type: "connect", client: new LlamaClient(serverUrl, result.auth.apiKey) };
}

/** The server `/llama` currently manages. `managed` is set when pi started the server. */
interface LlamaSession {
	client: LlamaClient;
	managed?: ManagedLlamaServerInfo;
}

function sessionHeader(session: LlamaSession): string[] {
	if (!session.managed) return [session.client.serverUrl];
	return [
		`Managed llama-server · ${session.managed.url}`,
		`Models:    ${displayPath(session.managed.modelsDir)}`,
		`Downloads: ${displayPath(huggingFaceCacheDir())}`,
	];
}

export default function llamaExtension(pi: ExtensionAPI): void {
	const managed = createManagedLlama();
	const provider = createLlamaProvider(managed);
	pi.registerProvider(provider.provider);

	const syncCatalog = async (
		ctx: ExtensionCommandContext,
		session: LlamaSession,
		catalog?: LlamaModelInfo[],
	): Promise<LlamaModelInfo[]> => {
		const signal = AbortSignal.timeout(15_000);
		const current = catalog ?? (await session.client.list({ signal }));
		provider.setCatalog(current, session.client.serverUrl, { managed: session.managed !== undefined });
		const result = await ctx.modelRegistry.refresh({
			providers: [LLAMA_PROVIDER_ID],
			// /llama already contacted the configured llama.cpp server, so keep this refresh live even in PI_OFFLINE.
			allowNetwork: true,
			signal,
		});
		if (result.aborted) throw new Error("Model catalog refresh timed out.");
		const refreshError = result.errors.get(LLAMA_PROVIDER_ID);
		if (refreshError) throw refreshError;
		return current;
	};

	const loadModel = async (
		ctx: ExtensionCommandContext,
		ui: LlamaUi,
		session: LlamaSession,
		catalog: LlamaModelInfo[],
		target: LlamaModelInfo,
	): Promise<void> => {
		const { client } = session;
		const loaded = catalog.filter((model) => model.id !== target.id && modelIsLoaded(model));
		let replace = false;
		if (loaded.length > 0) {
			const choice = await ui.select(`${loaded.length} model${loaded.length === 1 ? " is" : "s are"} loaded`, [
				"Unload all and load",
				"Keep loaded and load",
				"Cancel",
			]);
			if (!choice || choice === "Cancel") return;
			replace = choice === "Unload all and load";
		}

		const restoreLoaded = async (): Promise<void> => {
			ctx.ui.notify("Restoring previously loaded models");
			for (const model of loaded) await client.loadAndWait(model.id, () => {});
			await syncCatalog(ctx, session);
		};
		if (replace) {
			for (const model of loaded) await client.unloadAndWait(model.id);
		}

		try {
			const result = await runWithProgress(ui, {
				title: "Loading model",
				model: target.id,
				initialMessage: "Starting…",
				cancelTitle: "Stop loading?",
				cancelMessage: target.id,
				run: (signal, update) => client.loadAndWait(target.id, update, signal),
				cancel: () => client.unload(target.id),
			});
			if (result.cancelled) {
				if (replace) await restoreLoaded();
				return;
			}
			const refreshed = await syncCatalog(ctx, session);
			const loadedModel = refreshed.find((model) => model.id === target.id);
			ctx.ui.notify(
				loadedModel?.status.value === "loaded" ? `Loaded ${target.id}` : `Load started for ${target.id}`,
			);
		} catch (error) {
			if (replace) {
				try {
					await restoreLoaded();
				} catch {
					// Preserve the original load error.
				}
			}
			throw error;
		}
	};

	const unloadModel = async (
		ctx: ExtensionCommandContext,
		ui: LlamaUi,
		session: LlamaSession,
		model: LlamaModelInfo,
	): Promise<void> => {
		if (!(await ui.confirm("Unload model?", model.id))) return;
		await session.client.unloadAndWait(model.id);
		await syncCatalog(ctx, session);
		ctx.ui.notify(`Unloaded ${model.id}`);
	};

	const downloadModel = async (ctx: ExtensionCommandContext, ui: LlamaUi, session: LlamaSession): Promise<void> => {
		const { client } = session;
		const huggingFace = new HuggingFaceClient(await findHuggingFaceToken());
		const selected = await ui.searchModels((query, signal) => huggingFace.search(query, signal));
		if (!selected) return;
		const parsed = parseHuggingFaceModel(selected);
		ui.showStatus("Loading model details", parsed.repository);
		const details = await huggingFace.details(parsed.repository);
		if (details.gated) {
			const approval = details.gated === "manual" ? "Manual approval is required" : "Accept the access terms";
			const choice = await ui.select(
				`Hugging Face access required\n${details.id}\n\n${approval} at:\nhttps://huggingface.co/${details.id}\n\nThe llama.cpp server needs HF_TOKEN with access.`,
				["Continue", "Back"],
			);
			if (choice !== "Continue") return;
		}
		let quantization = parsed.quantization;
		if (!quantization && details.quantizations.length > 0) {
			const options = details.quantizations.map((entry) => {
				const detail = [
					entry.size === undefined ? undefined : formatBytes(entry.size),
					entry.name === "Q4_K_M" ? "recommended" : undefined,
				]
					.filter((value): value is string => Boolean(value))
					.join(" · ");
				return detail ? `${entry.name} · ${detail}` : entry.name;
			});
			const choice = await ui.select(`Select quantization\n${details.id}`, options);
			if (!choice) return;
			quantization = details.quantizations[options.indexOf(choice)]?.name;
			if (!quantization) return;
		}
		const model = quantization ? `${details.id}:${quantization}` : details.id;
		const result = await runWithProgress(ui, {
			title: "Downloading model",
			model,
			initialMessage: "Starting…",
			cancelTitle: "Stop download?",
			cancelMessage: model,
			run: (signal, update) => client.downloadAndWait(model, update, signal),
			cancel: () => client.unload(model),
		});
		if (result.cancelled) return;
		await syncCatalog(ctx, session, result.value);
		ctx.ui.notify(`Downloaded ${model}`);
	};

	pi.registerCommand("llama", {
		description: "Manage llama.cpp router models",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/llama is available in interactive mode", "warning");
				return;
			}
			const target = await configuredTarget(ctx);
			if (!target) return;
			await showLlamaUi(ctx, async (ui) => {
				let session: LlamaSession | undefined = target.type === "connect" ? { client: target.client } : undefined;

				// Managed sessions start or rejoin the server on every read, so a restarted or crashed server is
				// picked up again. `restart` replaces the running server first.
				const openSession = async (restart: boolean): Promise<LlamaSession> => {
					if (target.type === "connect") return { client: target.client };
					if (restart) ui.showStatus("Restarting llama-server", "Stopping the running server…");
					else if (!session) ui.showStatus("Starting llama-server", "Waiting for the server…");
					const server = restart ? await managed.restart() : await managed.acquire();
					if (session?.managed?.url === server.url) return session;
					return { client: new LlamaClient(server.url, server.apiKey), managed: server };
				};

				const readCatalog = async (restart = false): Promise<LlamaModelInfo[] | undefined> => {
					while (true) {
						try {
							session = await openSession(restart);
							return await syncCatalog(ctx, session);
						} catch (error) {
							const server = session?.client.serverUrl ?? "Managed llama-server";
							if ((await ui.connectionError(server, connectionErrorMessage(error))) === "close") {
								return undefined;
							}
							restart = false;
						}
					}
				};

				let catalog = await readCatalog();
				if (!catalog || !session) return;
				while (true) {
					const current: LlamaSession = session;
					const action = await ui.showModels(sessionHeader(current), catalog, {
						managed: current.managed !== undefined,
					});
					if (action.type === "close") return;
					let restart = false;
					let actionError: unknown;
					try {
						if (action.type === "download") await downloadModel(ctx, ui, current);
						else if (action.type === "log") {
							const logPath = current.managed?.logPath;
							if (logPath) await ui.showText(displayPath(logPath), await readLogTail(logPath));
						} else if (action.type === "restart") {
							restart = await ui.confirm(
								"Restart llama-server?",
								"Loaded models are unloaded. Requests from other pi sessions are interrupted.",
							);
						} else if (modelIsLoaded(action.model)) await unloadModel(ctx, ui, current, action.model);
						else if (action.model.status.value === "unloaded")
							await loadModel(ctx, ui, current, catalog, action.model);
						else ctx.ui.notify(`${action.model.id} is ${action.model.status.value}`, "warning");
					} catch (error) {
						actionError = error;
					}
					const refreshed = await readCatalog(restart);
					if (!refreshed) return;
					catalog = refreshed;
					if (actionError && !isConnectionError(actionError)) {
						ctx.ui.notify(actionError instanceof Error ? actionError.message : String(actionError), "error");
					}
				}
			});
		},
	});
}
