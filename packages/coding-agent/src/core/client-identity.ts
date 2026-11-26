import { type ClientIdentity, PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import type { GoogleAiPlanClient } from "@earendil-works/pi-ai/providers/google-ai-plan";
import { VERSION } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

/**
 * pi's Google `Desktop app` OAuth client for the Google AI Ultra plan, approved by Google for pi only. Forks and other
 * apps must register their own client. The secret is public by design: an installed app's secret cannot be kept
 * secret (RFC 8252 8.5), and Google treats it as non-confidential. Loopback redirect, PKCE and DPoP protect the
 * user's sign-in.
 */
export const PI_GOOGLE_AI_PLAN_CLIENT: GoogleAiPlanClient = {
	clientId: "1023131902207-qip7ip8p3hl0hi4cptjkv2dkigkt03om.apps.googleusercontent.com",
	clientSecret: "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",
};

/**
 * How pi's requests identify it to providers: a detailed `User-Agent` with pi's version, and attribution to pi as a
 * CLI agent while install telemetry is enabled.
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: isInstallTelemetryEnabled(settingsManager) ? PI_ATTRIBUTION : null,
	};
}
