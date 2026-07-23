import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	getKeybindings,
	isKittyProtocolActive,
	KeybindingsManager,
	setKeybindings,
	setKittyProtocolActive,
} from "@earendil-works/pi-tui";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";
import { keyText, withFileMutationQueue } from "../../../src/index.ts";

const fixtureDir = process.argv[2];
if (!fixtureDir) throw new Error("Fixture directory argument is required");

const extensionTypes = ["ts", "mjs", "cjs"] as const;
const result = await loadExtensions(
	extensionTypes.map((extension) => path.join(fixtureDir, `extension.${extension}`)),
	fixtureDir,
);
const commands = new Map(
	result.extensions.flatMap((extension) => [...extension.commands.values()]).map((command) => [command.name, command]),
);

const invokeCommand = async (name: string, args = ""): Promise<unknown> => {
	const command = commands.get(name);
	if (!command) throw new Error(`${name} command was not registered`);
	let notification: string | undefined;
	await command.handler(args, {
		ui: {
			notify(message: string) {
				notification = message;
			},
		},
	} as never);
	return notification === undefined ? undefined : JSON.parse(notification);
};

// Establish host state before asking each extension to report what its imported modules observe.
const keybindingDefinitions = { "app.tools.expand": { defaultKeys: "ctrl+o" } } as const;
setKittyProtocolActive(true);
setKeybindings(new KeybindingsManager(keybindingDefinitions, { "app.tools.expand": "ctrl+e" }));
const expectedKittyAndKeybindingState = {
	kittyActive: isKittyProtocolActive(),
	keyText: keyText("app.tools.expand"),
	keybindingKeys: getKeybindings().getKeys("app.tools.expand"),
};
const kittyAndKeybindingStatesByExtension = Object.fromEntries(
	await Promise.all(
		extensionTypes.map(async (extension) => [extension, await invokeCommand(`module-state:get:${extension}`)]),
	),
);

const kittySettersShareState: Record<string, boolean> = {};
for (const extension of extensionTypes) {
	setKittyProtocolActive(false);
	await invokeCommand(`kitty-protocol:set:${extension}`, "true");
	kittySettersShareState[extension] = isKittyProtocolActive();
}

const keybindingsShared: Record<string, boolean> = {};
for (const extension of extensionTypes) {
	setKeybindings(new KeybindingsManager(keybindingDefinitions, { "app.tools.expand": "ctrl+e" }));
	await invokeCommand(`module-keybindings:set:${extension}`, "ctrl+g");
	keybindingsShared[extension] =
		getKeybindings().getKeys("app.tools.expand").join(",") === "ctrl+g" && keyText("app.tools.expand") === "ctrl+g";
}

// Start each extension queue first and hold its callback open. The host queue then attempts
// to enter the same file section: a private queue overlaps, while the shared queue must wait.
const queuesShared: Record<string, boolean> = {};
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
const enterSectionKey = Symbol.for("pi-extension-shared-module-state.enter-section");
for (const extension of extensionTypes) {
	const queuePath = path.join(tmpdir(), `pi-extension-shared-module-state-${process.pid}-${extension}.tmp`);
	await writeFile(queuePath, "fixture", "utf8");
	let activeSections = 0;
	let queuesOverlapped = false;
	let firstSectionEntered = false;
	let resolveFirstSectionEntered!: () => void;
	const firstSectionEnteredPromise = new Promise<void>((resolve) => {
		resolveFirstSectionEntered = resolve;
	});
	let resolveConcurrentSectionEntered!: () => void;
	const concurrentSectionEnteredPromise = new Promise<void>((resolve) => {
		resolveConcurrentSectionEntered = resolve;
	});
	globals[enterSectionKey] = async () => {
		activeSections++;
		if (activeSections > 1) {
			queuesOverlapped = true;
			resolveConcurrentSectionEntered();
		}
		if (!firstSectionEntered) {
			firstSectionEntered = true;
			resolveFirstSectionEntered();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				// Release immediately if a second queue overlaps; otherwise release after the
				// timeout so a correctly serialized host queue can proceed without deadlocking.
				await Promise.race([
					concurrentSectionEnteredPromise,
					new Promise<void>((resolve) => {
						timeout = setTimeout(resolve, 250);
					}),
				]);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		}
		activeSections--;
	};
	try {
		const extensionQueue = invokeCommand(`module-state:queue:${extension}`, queuePath);
		// Do not start the host operation until the extension owns the first section.
		// This removes extension loading and queue registration timing from the overlap check.
		await Promise.race([
			firstSectionEnteredPromise,
			extensionQueue.then(() => {
				throw new Error(`${extension} extension queue completed without entering its callback`);
			}),
		]);
		await Promise.all([
			extensionQueue,
			withFileMutationQueue(queuePath, globals[enterSectionKey] as () => Promise<void>),
		]);
		queuesShared[extension] = !queuesOverlapped;
	} finally {
		delete globals[enterSectionKey];
		await rm(queuePath, { force: true });
	}
}
setKittyProtocolActive(false);

console.log(
	JSON.stringify({
		runtime: process.versions.bun ? "Bun" : "Node",
		errors: result.errors,
		extensionCount: result.extensions.length,
		expectedKittyAndKeybindingState,
		kittyAndKeybindingStatesByExtension,
		kittySettersShareState,
		keybindingsShared,
		queuesShared,
	}),
);
