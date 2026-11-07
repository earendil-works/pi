/**
 * OpenCode CLI bridge as a built-in extension. Vendored from pi-opencode-cli-bridge 0.2.17
 * (MIT, Copyright (c) 2024 luongnv89; see LICENSE). Registers the `opencode-cli` provider
 * so free OpenCode models appear in /model without a separate package install.
 */
import { existsSync } from "node:fs";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { checkCliStatus, opencodeBin, setupGuidance } from "./cli.ts";
import { configuredModels, DEFAULT_FREE_MODELS, discoverModels } from "./models.ts";
import { cleanupPiSessionState } from "./sessions.ts";
import { streamOpenCode } from "./stream.ts";
import type { OpenCodeModelInfo } from "./types/models.ts";

const PROVIDER_ID = "opencode-cli";
const API_ID = "opencode-cli-runner";
const MAX_SUPPORTED_OPENCODE_VERSION = "2.2.5";
let registeredModels: OpenCodeModelInfo[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;

async function refreshModels(
	pi: ExtensionAPI,
	ctx: { ui: { notify: (msg: string, level?: string) => void } },
): Promise<void> {
	const previousModels = new Set(registeredModels.map((model) => model.id));
	const { models, time, error } = await discoverModels({
		forceDiscovery: true,
	});
	registeredModels = models;
	lastDiscoveryTime = time;
	lastDiscoveryError = error;

	// Re-register the provider with the updated model list
	const providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] = {
		name: "OpenCode CLI",
		baseUrl: "cli:opencode",
		apiKey: "opencode-cli-no-api-key",
		api: API_ID,
		models: models.map(providerModel),
		streamSimple: streamOpenCode,
	};

	try {
		pi.registerProvider(PROVIDER_ID, providerConfig);
	} catch {
		// registerProvider may reject if already registered; the models array is already updated.
	}
	registerApiHandler();

	const newModels = models.filter((model) => !previousModels.has(model.id));

	let msg = `pi-opencode-cli-bridge: refreshed ${models.length} model(s).`;
	if (newModels.length > 0) {
		msg += ` ${newModels.length} new: ${newModels
			.slice(0, 5)
			.map((model) => model.id)
			.join(", ")}${newModels.length > 5 ? ", ..." : ""}`;
	}
	if (error) msg += ` Discovery issue: ${error}`;
	ctx.ui.notify(msg, "info");
}

function providerModel(model: OpenCodeModelInfo) {
	return {
		id: model.id,
		name: `${model.name} (OpenCode CLI)`,
		reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		input: model.image ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: model.cost,
	};
}

function statusLines(): string[] {
	const lines = [
		`Provider: ${PROVIDER_ID}`,
		`OpenCode binary: ${opencodeBin()}`,
		`OpenCode installed: ${existsSync(opencodeBin()) || opencodeBin() === "opencode" ? "check PATH with /pi-opencode-cli-bridge test" : "no"}`,
		`Registered models: ${registeredModels.length}`,
		`Last discovery: ${lastDiscoveryTime ? new Date(lastDiscoveryTime).toLocaleString() : "never"}`,
	];
	if (lastDiscoveryError) lines.push(`Discovery fallback: ${lastDiscoveryError}`);
	lines.push("");
	for (const model of registeredModels) {
		const capabilities = [model.reasoning ? "reasoning" : undefined, model.image ? "image" : undefined].filter(
			Boolean,
		);
		lines.push(`  - ${PROVIDER_ID}/${model.id}${capabilities.length > 0 ? ` (${capabilities.join(", ")})` : ""}`);
	}
	lines.push("");
	lines.push("OpenCode login is not required for the bundled free OpenCode models.");
	lines.push("OpenCode tools are disabled; Pi tool use is bridged with prompt-level tool-call markers.");
	lines.push("Run /pi-opencode-cli-bridge update to refresh the model list from opencode.");
	return lines;
}

function registerApiHandler(): void {
	registerApiProvider(
		{
			api: API_ID,
			stream: (model, context, options) => streamOpenCode(model, context, options),
			streamSimple: streamOpenCode,
		},
		PROVIDER_ID,
	);
}

export default async function opencodePiExtension(pi: ExtensionAPI) {
	const { models, time, error } = await discoverModels();
	registeredModels = models;
	lastDiscoveryTime = time;
	lastDiscoveryError = error;

	pi.registerProvider(PROVIDER_ID, {
		name: "OpenCode CLI",
		baseUrl: "cli:opencode",
		apiKey: "opencode-cli-no-api-key",
		api: API_ID,
		models: registeredModels.map(providerModel),
		streamSimple: streamOpenCode,
	});
	registerApiHandler();

	// Tear down per-Pi-session OpenCode state — project directories and
	// session records — when the Pi session ends for any reason (#74).
	pi.on("session_shutdown", () => cleanupPiSessionState());

	pi.on("session_start", async (_event: any, ctx: any) => {
		const cliStatus = await checkCliStatus();
		if (!cliStatus.ok) {
			const fastPathConfigured = Boolean(configuredModels()?.length);
			const fastPathNote = fastPathConfigured
				? "OPENCODE_PI_MODELS skipped discovery, so this was not detected at startup. "
				: "";
			ctx.ui.notify(
				`pi-opencode-cli-bridge: ${fastPathNote}${setupGuidance(cliStatus.detail ?? cliStatus.summary)}`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`pi-opencode-cli-bridge: registered ${registeredModels.length} OpenCode CLI model(s). Use /model and pick ${PROVIDER_ID}.`,
			"info",
		);
		const version = /\d+\.\d+\.\d+/.exec(cliStatus.summary)?.[0];
		if (!version || version.localeCompare(MAX_SUPPORTED_OPENCODE_VERSION, undefined, { numeric: true }) > 0) {
			ctx.ui.notify(
				`pi-opencode-cli-bridge: detected OpenCode ${version ?? cliStatus.summary}. This bridge supports OpenCode up to ${MAX_SUPPORTED_OPENCODE_VERSION}. Please install a supported version.`,
				"warning",
			);
		}
		if (lastDiscoveryError) {
			ctx.ui.notify(`pi-opencode-cli-bridge: model discovery used fallback (${lastDiscoveryError})`, "warning");
		}
	});

	pi.registerCommand("pi-opencode-cli-bridge", {
		description: "OpenCode CLI bridge status and setup help",
		handler: async (args: string, ctx: any) => {
			const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
			if (sub === "status") {
				for (const line of statusLines()) ctx.ui.notify(line, "info");
				return;
			}
			if (sub === "models") {
				for (const model of registeredModels) ctx.ui.notify(`${PROVIDER_ID}/${model.id}`, "info");
				ctx.ui.notify(`Override with OPENCODE_PI_MODELS="opencode/model-a,opencode/model-b"`, "info");
				return;
			}
			if (sub === "test") {
				ctx.ui.notify(
					`Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? DEFAULT_FREE_MODELS[0]} "Reply with exactly OK"`,
					"info",
				);
				ctx.ui.notify(
					`OpenCode check: ${opencodeBin()} run -m ${registeredModels[0]?.id ?? DEFAULT_FREE_MODELS[0]} --format json "Reply OK"`,
					"info",
				);
				return;
			}
			if (sub === "update") {
				await refreshModels(pi, ctx);
				for (const line of statusLines()) ctx.ui.notify(line, "info");
				return;
			}
			if (sub === "help") {
				ctx.ui.notify("Usage: /pi-opencode-cli-bridge [status|models|test|update|help]", "info");
				ctx.ui.notify("Set OPENCODE_PI_BIN to override the opencode executable.", "info");
				ctx.ui.notify("Set OPENCODE_PI_MODELS to register a custom comma-separated model list.", "info");
				return;
			}
			ctx.ui.notify(
				`Unknown /pi-opencode-cli-bridge subcommand: ${sub}. Try /pi-opencode-cli-bridge help`,
				"warning",
			);
		},
	});
}
