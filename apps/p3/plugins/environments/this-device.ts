// The machine type of this device (`local`, decision 117: the family's first type): the machine the server runs on,
// with no settings. Its host is Node's environment here with Pi's data folder hidden, a folder's names in one read,
// files created exclusively; its terminals are pending a decision (pi-env's daemon, node-pty or a helper).

import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { forbidden, obj } from "@earendil-works/p3/v1";
import { NodeExecutionEnv } from "@earendil-works/p3/v1/server";
import type { MachineHost, MachineType, NameEntry, NewFile } from "./contract.server.ts";
import { messages } from "./messages.ts";

/** The type's name: what this device's machine stores (its seeded thing, which has no row, is of it). */
export const THIS_DEVICE_TYPE = "local";

/** This device's machine type, its data folder `dataDir` hidden. */
export function thisDeviceType(dataDir: string): MachineType {
	return {
		type: THIS_DEVICE_TYPE,
		label: messages.message("thisDevice"),
		settings: obj({}),
		connect: async () => host(dataDir),
	};
}

/** This device's host: one per connection, nothing to close. */
function host(dataDir: string): MachineHost {
	return {
		env: new NodeExecutionEnv({ cwd: homedir() }),
		hidden: [dataDir],
		listNames: async (folder) => (await readdir(folder, { withFileTypes: true })).map(nameOf),
		createFile,
		openPty: async () => {
			throw forbidden("environments: this device has no terminals yet", {
				message: messages.message("noTerminals"),
			});
		},
		close: async () => {},
	};
}

/** A folder entry's name and kind (a socket or a device counts as a file). */
function nameOf(entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): NameEntry {
	return { name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file" };
}

/** A new file at `path`: `wx` (O_CREAT | O_EXCL) refuses any existing name, a symbolic link included. */
async function createFile(path: string): Promise<NewFile> {
	const file = await open(path, "wx");
	return {
		write: async (bytes) => {
			for (let at = 0; at < bytes.length; ) at += (await file.write(bytes, at, bytes.length - at)).bytesWritten;
		},
		close: () => file.close(),
	};
}
