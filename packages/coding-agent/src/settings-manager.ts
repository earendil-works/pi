import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { type AutoHandoffMode, DEFAULT_AUTO_HANDOFF_MODE, isAutoHandoffMode } from "./auto-handoff.js";

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	queueMode?: "all" | "one-at-a-time";
	autoHandoffMode?: AutoHandoffMode;
	theme?: string;
	notifications?: boolean;
	googleClientId?: string;
	googleClientSecret?: string;
}

export class SettingsManager {
	private settingsPath: string;
	private settings: Settings;

	constructor(baseDir?: string) {
		const dir = baseDir || join(homedir(), ".mu", "agent");
		this.settingsPath = join(dir, "settings.json");
		this.settings = this.load();
	}

	private load(): Settings {
		if (!existsSync(this.settingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch (error) {
			console.error(`Warning: Could not read settings file: ${error}`);
			return {};
		}
	}

	private save(): void {
		try {
			// Ensure directory exists
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}

			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.settings.lastChangelogVersion = version;
		this.save();
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.settings.defaultProvider = provider;
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.settings.defaultModel = modelId;
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getQueueMode(): "all" | "one-at-a-time" {
		// Back-compat: older versions stored "steer". Treat it as the default.
		const mode = this.settings.queueMode;
		return mode === "all" ? "all" : "one-at-a-time";
	}

	setQueueMode(mode: "all" | "one-at-a-time"): void {
		this.settings.queueMode = mode;
		this.save();
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.settings.theme = theme;
		this.save();
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.settings.defaultThinkingLevel = level;
		this.save();
	}

	getAutoHandoffMode(): AutoHandoffMode {
		const mode = this.settings.autoHandoffMode;
		return isAutoHandoffMode(mode) ? mode : DEFAULT_AUTO_HANDOFF_MODE;
	}

	setAutoHandoffMode(mode: AutoHandoffMode): void {
		this.settings.autoHandoffMode = mode;
		this.save();
	}

	getNotifications(): boolean {
		return this.settings.notifications ?? true;
	}

	setNotifications(enabled: boolean): void {
		this.settings.notifications = enabled;
		this.save();
	}

	getGoogleClientId(): string | undefined {
		return this.settings.googleClientId;
	}

	setGoogleClientId(clientId: string): void {
		this.settings.googleClientId = clientId;
		this.save();
	}

	getGoogleClientSecret(): string | undefined {
		return this.settings.googleClientSecret;
	}

	setGoogleClientSecret(clientSecret: string): void {
		this.settings.googleClientSecret = clientSecret;
		this.save();
	}
}
