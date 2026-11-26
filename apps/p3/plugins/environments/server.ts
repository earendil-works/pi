// The environments plugin on the server: the machine family kind (`serveThing`: the things plugin admits every caller,
// registers the kind and makes this device's machine in Pi once, its one thing; the create hook checks and writes a
// machine's type and settings, the delete hook ends its connection, row and terminals), the machine types
// (`MachineTypes`, this device's contributed here), the machines' connections and info (machines.ts) and their store
// (store.ts), the terminal host (`TerminalHosts`, terminal-host.ts) kept by `TerminalKeeper` with its closing for the
// delete hooks, each owner's terminals (`TerminalList`), the owner's list of machines (`Environments`) and this
// device's id for everyone signed in and every worker (`ThisDevice`).

import { hostname } from "node:os";
import { admitOwner, contribute, defineFacet } from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { OneThing, ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import {
	MachineHosts,
	type MachineType,
	MachineTypes,
	TerminalHosts,
	TerminalKeeper,
	TerminalList,
	type TerminalRow,
} from "./contract.server.ts";
import { Environments, ThisDevice } from "./contract.ts";
import { MachineKind } from "./kind.ts";
import { MachineInfoHere, MachineKeeper, serveMachines } from "./machines.ts";
import { serveStore } from "./store.ts";
import { Terminals } from "./terminal-host.ts";
import { THIS_DEVICE_TYPE, thisDeviceType } from "./this-device.ts";

/** This device's machine: the machine kind's one thing. */
const THIS_DEVICE = { kind: MachineKind.name };

export default defineFacet((host) => {
	host.serve(MachineHosts, { compose: (table) => table[0]?.value ?? (async () => undefined) });
	host.serve(MachineTypes, {
		// The first by plugin name wins a type's name.
		compose: (table) => {
			const byName = new Map<string, (typeof table)[number]>();
			for (const item of table) if (!byName.has(item.value.type)) byName.set(item.value.type, item);
			return byName;
		},
	});
	host.serve(TerminalHosts, { compose: (table) => table[0]?.value });
	serveStore(host);
	serveMachines(host);

	serveThing(host, MachineKind, {
		one: { name: hostname() },
		implement: ({ thing }, _admitted, self) => ({ info: self.get(MachineInfoHere, { machine: thing }).info }),
		create: async (thing, input, ctx) => {
			await (await ctx.get(MachineKeeper, {})).make({ machine: thing, input }, ctx);
		},
		// A machine that went takes its connection and terminals with it: nobody could reach them after.
		delete: async (thing, ctx) => {
			await (await ctx.get(TerminalKeeper, {})).closeMachine({ machine: thing }, ctx);
			await (await ctx.get(MachineKeeper, {})).forget({ machine: thing }, ctx);
		},
	});

	contribute(host, "environments.this-device-type", (self) => {
		const type: MachineType = thisDeviceType(self.registry(ServerRuntime).value.dataDir);
		self.contribute(MachineTypes, type);
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
			// Only this device's machine is listed until machines people make come with the SSH type.
			const environments = self.derive([device.thing, named], ([id, { rows }]) => [
				{ id, name: rows[0]?.name ?? "", type: THIS_DEVICE_TYPE },
			]);
			return { environments };
		},
		{ admit: admitOwner },
	);

	host.serve(ThisDevice, (_params, _principal, self) => ({ machine: self.get(OneThing, THIS_DEVICE).thing }));
});
