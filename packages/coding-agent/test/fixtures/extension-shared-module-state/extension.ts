import { type ExtensionAPI, keyText, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	isKittyProtocolActive,
	KeybindingsManager,
	type KeyId,
	setKeybindings,
	setKittyProtocolActive,
} from "@earendil-works/pi-tui";

const KEYBINDING_DEFINITIONS = { "app.tools.expand": { defaultKeys: "ctrl+o" } } as const;
const ENTER_SECTION_KEY = Symbol.for("pi-extension-shared-module-state.enter-section");

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("module-state:get:ts", {
		description: "Read shared module state from a TypeScript extension",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				JSON.stringify([
					{
						kittyActive: isKittyProtocolActive(),
						keyText: keyText("app.tools.expand"),
						keybindingKeys: getKeybindings().getKeys("app.tools.expand"),
					},
				]),
				"info",
			);
		},
	});

	pi.registerCommand("kitty-protocol:set:ts", {
		description: "Update shared Kitty protocol state from a TypeScript extension",
		handler: async (args) => {
			setKittyProtocolActive(args === "true");
		},
	});

	pi.registerCommand("module-keybindings:set:ts", {
		description: "Update shared keybindings from a TypeScript extension",
		handler: async (args) => {
			setKeybindings(new KeybindingsManager(KEYBINDING_DEFINITIONS, { "app.tools.expand": args as KeyId }));
		},
	});

	pi.registerCommand("module-state:queue:ts", {
		description: "Enter the shared file mutation queue from a TypeScript extension",
		handler: async (args) => {
			const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
			const enterSection = globals[ENTER_SECTION_KEY];
			if (typeof enterSection !== "function") throw new Error("Queue probe callback is not registered");
			await withFileMutationQueue(args, enterSection as () => Promise<void>);
		},
	});
}
