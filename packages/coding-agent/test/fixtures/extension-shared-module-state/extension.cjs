const ENTER_SECTION_KEY = Symbol.for("pi-extension-shared-module-state.enter-section");

module.exports = async function (pi) {
	const { keyText, withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
	const { getKeybindings, isKittyProtocolActive, KeybindingsManager, setKeybindings, setKittyProtocolActive } =
		await import("@earendil-works/pi-tui");
	const keybindingDefinitions = { "app.tools.expand": { defaultKeys: "ctrl+o" } };

	pi.registerCommand("module-state:get:cjs", {
		description: "Read shared module state from a CommonJS extension",
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

	pi.registerCommand("kitty-protocol:set:cjs", {
		description: "Update shared Kitty protocol state from a CommonJS extension",
		handler: async (args) => {
			setKittyProtocolActive(args === "true");
		},
	});

	pi.registerCommand("module-keybindings:set:cjs", {
		description: "Update shared keybindings from a CommonJS extension",
		handler: async (args) => {
			setKeybindings(new KeybindingsManager(keybindingDefinitions, { "app.tools.expand": args }));
		},
	});

	pi.registerCommand("module-state:queue:cjs", {
		description: "Enter the shared file mutation queue from a CommonJS extension",
		handler: async (args) => {
			const enterSection = globalThis[ENTER_SECTION_KEY];
			if (typeof enterSection !== "function") throw new Error("Queue probe callback is not registered");
			await withFileMutationQueue(args, enterSection);
		},
	});
};
