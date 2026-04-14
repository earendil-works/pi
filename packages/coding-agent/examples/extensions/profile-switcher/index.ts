import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	ensureProfilesConfig,
	loadProfilesConfig,
	type ProfileDefinition,
	type ProfilesConfig,
	parseModelRef,
	saveProfilesConfig,
	updateAgentProfileContent,
} from "./profiles.js";

const PROFILE_STATUS_KEY = "profile";

function readAvailableModelIds(ctx: ExtensionContext): Set<string> {
	return new Set(ctx.modelRegistry.getAll().map((model) => `${model.provider}/${model.id}`));
}

function getProfilesPath(): string {
	return join(getAgentDir(), "profiles.json");
}

function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function getAgentsDir(): string {
	return join(getAgentDir(), "agents");
}

function readSettings(settingsPath: string): Record<string, unknown> {
	if (!existsSync(settingsPath)) {
		return {};
	}
	const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
}

function writeSettings(settingsPath: string, settings: Record<string, unknown>): void {
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function updateEnabledModels(profile: ProfileDefinition): void {
	const settingsPath = getSettingsPath();
	const settings = readSettings(settingsPath);
	if (profile.enabledModels) {
		settings.enabledModels = profile.enabledModels;
	} else {
		delete settings.enabledModels;
	}
	writeSettings(settingsPath, settings);
}

function updateAgentFiles(profile: ProfileDefinition): void {
	const agentsDir = getAgentsDir();
	const entries = readdirSync(agentsDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) {
			continue;
		}
		const agentName = entry.name.replace(/\.md$/, "");
		const profileAgent = profile.agents[agentName];
		if (!profileAgent) {
			continue;
		}
		const filePath = join(agentsDir, entry.name);
		const content = readFileSync(filePath, "utf-8");
		const updated = updateAgentProfileContent(content, profileAgent);
		if (updated !== content) {
			writeFileSync(filePath, updated, "utf-8");
		}
	}
}

function validateProfile(profileName: string, profile: ProfileDefinition, ctx: ExtensionContext): void {
	const refs = [profile.main.model];
	for (const agent of Object.values(profile.agents)) {
		refs.push(agent.model);
		if (agent.fallbackModel) {
			refs.push(agent.fallbackModel);
		}
	}
	for (const fallbackTarget of profile.fallbackTargets ?? []) {
		refs.push(fallbackTarget);
	}

	for (const ref of refs) {
		const parsed = parseModelRef(ref);
		const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) {
			throw new Error(`Profile "${profileName}" references unavailable model ${parsed.fullId}.`);
		}
	}
}

function setStatus(ctx: ExtensionContext, profileName: string | undefined): void {
	if (!profileName) {
		ctx.ui.setStatus(PROFILE_STATUS_KEY, undefined);
		return;
	}
	ctx.ui.setStatus(PROFILE_STATUS_KEY, ctx.ui.theme.fg("accent", `profile:${profileName}`));
}

function describeProfile(profileName: string, profile: ProfileDefinition): string {
	const agentCount = Object.keys(profile.agents).length;
	const main = profile.main.model;
	const fallbacks = (profile.fallbackTargets ?? []).join(", ") || "none";
	return `${profileName}: main=${main} | agents=${agentCount} | fallback=${fallbacks}`;
}

async function applyProfile(
	profileName: string,
	config: ProfilesConfig,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<void> {
	const profile = config.profiles[profileName];
	if (!profile) {
		const available = Object.keys(config.profiles).join(", ");
		throw new Error(`Unknown profile "${profileName}". Available: ${available || "(none)"}`);
	}

	validateProfile(profileName, profile, ctx);

	const mainModelRef = parseModelRef(profile.main.model);
	const model = ctx.modelRegistry.find(mainModelRef.provider, mainModelRef.modelId);
	if (!model) {
		throw new Error(`Main model ${mainModelRef.fullId} is not available.`);
	}

	const success = await pi.setModel(model);
	if (!success) {
		throw new Error(`No API key is available for ${mainModelRef.fullId}.`);
	}

	if (mainModelRef.thinkingLevel) {
		pi.setThinkingLevel(mainModelRef.thinkingLevel);
	}

	updateAgentFiles(profile);
	updateEnabledModels(profile);
	config.activeProfile = profileName;
	saveProfilesConfig(getProfilesPath(), config);
	setStatus(ctx, profileName);
	ctx.ui.notify(`Profile "${profileName}" applied`, "info");
}

function ensureConfig(ctx: ExtensionContext): ProfilesConfig {
	return ensureProfilesConfig(getProfilesPath(), readAvailableModelIds(ctx));
}

export default function profileSwitcher(pi: ExtensionAPI) {
	pi.registerFlag("profile", {
		description: "Profile configuration to apply",
		type: "string",
	});

	pi.registerCommand("profile", {
		description: "Switch model profiles (usage: /profile <name>|status|list)",
		handler: async (args, ctx) => {
			const config = ensureConfig(ctx);
			const trimmed = args.trim();

			if (!trimmed || trimmed === "status") {
				const activeProfile = config.activeProfile;
				if (!activeProfile) {
					ctx.ui.notify("No active profile set", "info");
					return;
				}
				const profile = config.profiles[activeProfile];
				ctx.ui.notify(describeProfile(activeProfile, profile), "info");
				return;
			}

			if (trimmed === "list") {
				const descriptions = Object.entries(config.profiles)
					.map(([profileName, profile]) => describeProfile(profileName, profile))
					.join("\n");
				ctx.ui.notify(descriptions || "No profiles configured", "info");
				return;
			}

			await applyProfile(trimmed, config, ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = ensureConfig(ctx);
		const profileFlag = pi.getFlag("profile");
		if (typeof profileFlag === "string" && profileFlag.trim()) {
			try {
				await applyProfile(profileFlag.trim(), config, ctx, pi);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Profile switch failed: ${message}`, "warning");
			}
			return;
		}
		setStatus(ctx, config.activeProfile);
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const config = loadProfilesConfig(getProfilesPath());
			setStatus(ctx, config.activeProfile);
		} catch {
			setStatus(ctx, undefined);
		}
	});
}
