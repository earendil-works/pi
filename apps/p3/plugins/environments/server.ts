// The environments plugin on the server: the machine kind (`serveThing`: the things plugin admits every caller,
// registers the kind and makes this device's machine in Pi once, its one thing), a machine's info (one local object
// per machine, read by every reference to it), its host for server code (`MachineHosts`: Node's environment on this
// device, Pi's data folder hidden), the terminal host (`TerminalHosts`, terminal-host.ts) kept by `TerminalKeeper`
// with its closing for the delete hooks, each owner's terminals (`TerminalList`), the owner's list of machines (`Environments`) and this device's id for everyone
// signed in and every worker (`ThisDevice`).

import { open, readdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { admitOwner, contribute, defineFacet, forbidden, local, type Static, str } from "@earendil-works/p3/v1";
import { NodeExecutionEnv, ServerRuntime } from "@earendil-works/p3/v1/server";
import { OneThing, ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import {
	type MachineHost,
	MachineHosts,
	type NameEntry,
	type NewFile,
	TerminalHosts,
	TerminalKeeper,
	TerminalList,
	type TerminalRow,
} from "./contract.server.ts";
import { Environments, ThisDevice } from "./contract.ts";
import { MachineInfo, MachineKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { Terminals } from "./terminal-host.ts";

/** This device's machine: the machine kind's one thing. */
const THIS_DEVICE = { kind: MachineKind.name };

/** One machine's info, live: one object per machine, however many hold it. */
const MachineInfoHere = local("environments.machine-info", {
	version: 1,
	params: { machine: str() },
	members: { info: MachineInfo },
});

export default defineFacet((host) => {
	host.serve(MachineHosts, {
		compose: (table) => (machine) => {
			for (const { value } of table) {
				const found = value(machine);
				if (found !== undefined) return found;
			}
			return undefined;
		},
	});
	host.serve(TerminalHosts, { compose: (table) => table[0]?.value });

	serveThing(host, MachineKind, {
		one: { name: hostname() },
		implement: ({ thing }, _admitted, self) => ({ info: self.get(MachineInfoHere, { machine: thing }).info }),
		// A machine that went takes its terminals with it: nobody could reach them after.
		delete: async (thing, ctx) => {
			await (await ctx.get(TerminalKeeper, {})).closeMachine({ machine: thing }, ctx);
		},
	});

	host.serve(MachineInfoHere, ({ machine }, self) => {
		const named = self.liveQuery(self.get(ThingsStore, {}).things.one, { thing: machine }, { first: 1 });
		const info = self.derive(
			[named],
			([{ rows }]): Static<typeof MachineInfo> => ({ name: rows[0]?.name ?? "", status: "ready" }),
		);
		return { info };
	});

	contribute(host, "environments.this-device-host", (self) => {
		const device = self.get(OneThing, THIS_DEVICE);
		const runtime = self.registry(ServerRuntime);
		const local: MachineHost = {
			env: new NodeExecutionEnv({ cwd: homedir() }),
			hidden: [runtime.value.dataDir],
			listNames: async (folder) => (await readdir(folder, { withFileTypes: true })).map(nameOf),
			createFile,
			// The PTY of this device is pending a decision (pi-env's daemon, node-pty or a helper): one implementation.
			openPty: async () => {
				throw forbidden("environments: this device has no terminals yet", {
					message: messages.message("noTerminals"),
				});
			},
		};
		// Read at each call: this object is live, so this device's machine exists.
		self.contribute(MachineHosts, (machine) => (machine === device.thing.value ? local : undefined));
	});

	host.serve(TerminalKeeper, (_params, self) => {
		const hosts = self.registry(MachineHosts);
		const terminals = new Terminals(() => hosts.value);
		self.open(
			async () => terminals,
			(ended) => ended.end(),
		);
		self.contribute(TerminalHosts, terminals);
		return {
			closeMachine: async ({ machine }) => {
				terminals.closeMachine(machine);
				return null;
			},
			closeOwners: async ({ prefix }) => {
				terminals.closeOwners(prefix);
				return null;
			},
		};
	});
	// Held while the plugin is loaded, so a terminal outlives its viewers and the plugins showing it.
	contribute(host, "environments.terminals-keep", (self) => void self.get(TerminalKeeper, {}));

	host.serve(TerminalList, ({ owner }, self) => {
		// Held, so the host is there; read when the object opens, after the keeper contributed it.
		self.get(TerminalKeeper, {});
		const terminals = self.registry(TerminalHosts);
		const list = self.writable<TerminalRow[]>([]);
		self.open(
			async () => {
				const at = terminals.value;
				list.set(at?.list(owner) ?? []);
				return at?.watch(owner, (rows) => list.set(rows));
			},
			(stop) => stop?.(),
		);
		return { terminals: self.derive([list], ([rows]) => rows) };
	});

	host.serve(
		Environments,
		(_params, _principal, _admitted, self) => {
			const device = self.get(OneThing, THIS_DEVICE);
			const thing = self.derive([device.thing], ([id]) => ({ thing: id }));
			const named = self.liveQuery(self.get(ThingsStore, {}).things.one, thing, { first: 1 });
			// Only this device's machine exists until SSH machines come.
			const environments = self.derive([device.thing, named], ([id, { rows }]) => [
				{ id, name: rows[0]?.name ?? "", kind: "local" as const },
			]);
			return { environments };
		},
		{ admit: admitOwner },
	);

	host.serve(ThisDevice, (_params, _principal, self) => ({ machine: self.get(OneThing, THIS_DEVICE).thing }));
});

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
