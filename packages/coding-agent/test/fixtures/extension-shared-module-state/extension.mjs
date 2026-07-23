import { keyText, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	isKittyProtocolActive,
	KeybindingsManager,
	setKeybindings,
	setKittyProtocolActive,
} from "@earendil-works/pi-tui";

const KEYBINDING_DEFINITIONS = { "app.tools.expand": { defaultKeys: "ctrl+o" } };
const topLevelCodingAgent = await import("@earendil-works/pi-coding-agent");
const topLevelTui = await import("@earendil-works/pi-tui");
const ENTER_SECTION_KEY = Symbol.for("pi-extension-shared-module-state.enter-section");

export default function (pi) {
	pi.registerCommand("module-state:get:mjs", {
		description: "Read shared module state from an ESM extension",
		handler: async (_args, ctx) => {
			const dynamicCodingAgent = await import("@earendil-works/pi-coding-agent");
			const dynamicTui = await import("@earendil-works/pi-tui");
			ctx.ui.notify(
				JSON.stringify([
					{
						kittyActive: isKittyProtocolActive(),
						keyText: keyText("app.tools.expand"),
						keybindingKeys: getKeybindings().getKeys("app.tools.expand"),
					},
					{
						kittyActive: topLevelTui.isKittyProtocolActive(),
						keyText: topLevelCodingAgent.keyText("app.tools.expand"),
						keybindingKeys: topLevelTui.getKeybindings().getKeys("app.tools.expand"),
					},
					{
						kittyActive: dynamicTui.isKittyProtocolActive(),
						keyText: dynamicCodingAgent.keyText("app.tools.expand"),
						keybindingKeys: dynamicTui.getKeybindings().getKeys("app.tools.expand"),
					},
				]),
				"info",
			);
		},
	});

	pi.registerCommand("kitty-protocol:set:mjs", {
		description: "Update shared Kitty protocol state from an ESM extension",
		handler: async (args) => {
			setKittyProtocolActive(args === "true");
		},
	});

	pi.registerCommand("module-keybindings:set:mjs", {
		description: "Update shared keybindings from an ESM extension",
		handler: async (args) => {
			setKeybindings(new KeybindingsManager(KEYBINDING_DEFINITIONS, { "app.tools.expand": args }));
		},
	});

	pi.registerCommand("module-state:queue:mjs", {
		description: "Enter the shared file mutation queue from an ESM extension",
		handler: async (args) => {
			const enterSection = globalThis[ENTER_SECTION_KEY];
			if (typeof enterSection !== "function") throw new Error("Queue probe callback is not registered");
			await withFileMutationQueue(args, enterSection);
		},
	});
}
