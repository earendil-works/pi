import type { Terminal } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { type StartupComposerHandoff, showStartupInput, showStartupSelector } from "./startup-ui.ts";

export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsManager;
	hasUI: boolean;
	terminal?: Terminal;
	startupComposer?: StartupComposerHandoff;
}): ProjectTrustContext {
	return {
		cwd: options.cwd,
		mode: options.mode === "interactive" ? "tui" : options.mode,
		hasUI: options.hasUI,
		ui: {
			select: async (title, selectOptions) => {
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				return showStartupSelector(
					options.settingsManager,
					title,
					selectOptions.map((option) => ({ label: option, value: option })),
					{
						terminal: options.terminal,
						ui: options.startupComposer?.ui,
						handoff: options.startupComposer,
					},
				);
			},
			confirm: async (title, message) => {
				if (!options.hasUI) {
					return false;
				}
				if (options.mode !== "interactive") {
					return false;
				}
				return (
					(await showStartupSelector(
						options.settingsManager,
						`${title}\n${message}`,
						[
							{ label: "Yes", value: true },
							{ label: "No", value: false },
						],
						{
							terminal: options.terminal,
							ui: options.startupComposer?.ui,
							handoff: options.startupComposer,
						},
					)) ?? false
				);
			},
			input: async (title, placeholder) => {
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				return showStartupInput(options.settingsManager, title, placeholder, {
					terminal: options.terminal,
					ui: options.startupComposer?.ui,
					handoff: options.startupComposer,
				});
			},
			notify: (message, type = "info") => {
				if (options.mode !== "interactive") {
					const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
					console.error(color(message));
				}
			},
		},
	};
}
