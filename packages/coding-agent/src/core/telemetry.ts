import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * Whether pi sends its anonymous install/update ping and provider attribution headers.
 * `PI_TELEMETRY` wins because it names pi explicitly; otherwise the cross-tool `DO_NOT_TRACK`
 * convention (https://consoledonottrack.com) turns telemetry off before the setting is consulted.
 */
export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.PI_TELEMETRY !== undefined) return isTruthyEnvFlag(env.PI_TELEMETRY);
	if (isTruthyEnvFlag(env.DO_NOT_TRACK)) return false;
	return settingsManager.getEnableInstallTelemetry();
}
