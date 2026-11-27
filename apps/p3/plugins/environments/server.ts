// The environments plugin on the server: the machine family kind (`serveThing`: the things plugin admits every caller,
// registers the kind and makes this device's machine in Pi once, its one thing; the create hook checks and writes a
// machine's type and settings, the delete hook ends its connection, row and terminals), the machines' types, hosts and
// info (machines.ts) and their store (store.ts), this device's type (this-device.ts), the terminal host
// (terminal-host.ts), the owner's list of machines (`Environments`) and this device's id for everyone signed in and
// every worker (`ThisDevice`).

import { hostname } from "node:os";
import { admitOwner, defineFacet } from "@earendil-works/p3/v1";
import { OneThing, ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { TerminalKeeper } from "./contract.terminal-host.server.ts";
import { Environments, ThisDevice } from "./contract.ts";
import { MachineKind } from "./kind.ts";
import { MachineInfoHere, MachineKeeper, serveMachines } from "./machines.ts";
import { serveStore } from "./store.ts";
import { serveTerminals } from "./terminal-host.ts";
import { serveThisDevice, THIS_DEVICE, THIS_DEVICE_TYPE } from "./this-device.ts";

/** This plugin's name: the maker of the seeded machine. */
const ENVIRONMENTS_PLUGIN = "@earendil-works/p3-environments";

export default defineFacet((host) => {
	serveStore(host);
	serveMachines(host);
	serveThisDevice(host);
	serveTerminals(host);

	serveThing(host, MachineKind, {
		implement: ({ thing }, _admitted, self) => ({ info: self.get(MachineInfoHere, { machine: thing }).info }),
		// The seeded machine (made by this plugin, with no input) is this device's, which stores nothing (machines.ts),
		// until the things plugin's `one` takes an input (things2): then it is a `local` machine with a row like any.
		create: async ({ thing, input, by }, ctx) => {
			if (input === undefined && by.kind === "plugin" && by.plugin === ENVIRONMENTS_PLUGIN) return undefined;
			await (await ctx.get(MachineKeeper, {})).make({ machine: thing, input }, ctx);
			return undefined;
		},
		// A machine that went takes its connection and terminals with it: nobody could reach them after.
		delete: async (thing, ctx) => {
			await (await ctx.get(TerminalKeeper, {})).closeMachine({ machine: thing }, ctx);
			await (await ctx.get(MachineKeeper, {})).forget({ machine: thing }, ctx);
		},
		one: { name: hostname() },
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
