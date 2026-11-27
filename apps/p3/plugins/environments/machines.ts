// The machines on the server, whatever their type (decision 117): the registries of their types (`MachineTypes`, the
// first by plugin name winning a type's name) and hosts (`MachineHosts`); `MachineKeeper`, held while the plugin is
// loaded, connects a machine from its type and settings when it is first asked for (`MachineHosts`, which it
// contributes), keeps the connection until the settings change, the machine goes or the plugin unloads, and writes a
// new machine's type and settings once checked (`make`, the kind's create hook); `MachineInfoHere` is one machine's
// info, one object per machine however many hold it. Every machine has a row, this device's seeded one too (its `one`
// input). A machine whose type is not installed stays and is unavailable.

import {
	BACKGROUND_CONTEXT,
	checkValue,
	contribute,
	type FacetHost,
	invalid,
	local,
	method,
	obj,
	type P3Principal,
	reportError,
	type Static,
	str,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import { type MachineHost, MachineHosts, type MachineType, MachineTypes } from "./contract.server.ts";
import { MachineInfo, MachineInput } from "./kind.ts";
import { messages } from "./messages.ts";
import { MachinesStore } from "./store.ts";

/** The machines' connections and writes, once per server: what the kind's hooks reach through a `ctx`. */
export const MachineKeeper = local("environments.machine-keeper", {
	version: 1,
	params: {},
	members: {
		/** Checks `input`'s settings against its type and writes them as machine `machine`'s. */
		make: method(obj({ machine: str(), input: MachineInput })),
		/** Ends machine `machine`'s connection and removes its row (the machine deleted). */
		forget: method(obj({ machine: str() })),
	},
});

/** One machine's info, live. */
export const MachineInfoHere = local("environments.machine-info", {
	version: 1,
	params: { machine: str() },
	members: { info: MachineInfo },
});

/** A machine's connection: the type and settings revision it was made from, and its host. */
type Connection = { readonly type: MachineType; readonly revision: number; readonly host: Promise<MachineHost> };

/** Serves on `host` the machines' registries, `MachineKeeper` (held while the plugin is loaded), `MachineInfoHere`. */
export function serveMachines(host: FacetHost<P3Principal>): void {
	host.serve(MachineHosts, { compose: (table) => table[0]?.value ?? (async () => undefined) });
	host.serve(MachineTypes, {
		// The first by plugin name wins a type's name.
		compose: (table) => {
			const byName = new Map<string, (typeof table)[number]>();
			for (const item of table) if (!byName.has(item.value.type)) byName.set(item.value.type, item);
			return byName;
		},
	});
	serveKeeper(host);
	serveInfo(host);
}

/** Serves `MachineKeeper`, which connects machines and writes their rows, and holds it while the plugin is loaded. */
function serveKeeper(host: FacetHost<P3Principal>): void {
	host.serve(MachineKeeper, (_params, self) => {
		const types = self.registry(MachineTypes);
		const store = self.get(MachinesStore, {});
		const connections = new Map<string, Connection>();
		self.open(
			async () => connections,
			(all) => {
				for (const connection of all.values()) disconnect(connection);
				all.clear();
			},
		);
		const drop = (machine: string) => {
			const known = connections.get(machine);
			connections.delete(machine);
			if (known !== undefined) disconnect(known);
		};
		self.contribute(MachineHosts, async (machine, context) => {
			const row = await store.row({ machine }, context);
			const type = row === null ? undefined : types.value.get(row.type)?.value;
			const revision = row?.revision ?? 0;
			const known = connections.get(machine);
			if (known !== undefined && (known.type !== type || known.revision !== revision)) drop(machine);
			if (row === null || type === undefined) return undefined;
			const current = connections.get(machine);
			if (current !== undefined) return current.host;
			// Shared by every caller after this one: no caller's cancel ends it.
			const made: Connection = { type, revision, host: type.connect(row.settings, BACKGROUND_CONTEXT) };
			connections.set(machine, made);
			// A failed connection is tried again by the next call.
			made.host.catch(() => connections.get(machine) === made && connections.delete(machine));
			return made.host;
		});
		return {
			make: async ({ machine, input }, ctx) => {
				const { type, settings } = madeOf(input, types.value);
				await store.put({ machine, type, settings }, ctx);
				return null;
			},
			forget: async ({ machine }, ctx) => {
				drop(machine);
				await store.remove({ machine }, ctx);
				return null;
			},
		};
	});
	contribute(host, "environments.machines-keep", (self) => void self.get(MachineKeeper, {}));
}

/** Serves `MachineInfoHere`: one machine's info, one object per machine. */
function serveInfo(host: FacetHost<P3Principal>): void {
	host.serve(MachineInfoHere, ({ machine }, self) => {
		const named = self.liveQuery(self.get(ThingsStore, {}).things.one, { thing: machine }, { first: 1 });
		const store = self.get(MachinesStore, {});
		const types = self.registry(MachineTypes);
		// A machine's type is written once, when it is made.
		const stored = self.writable<string | undefined>(undefined);
		self.open(
			async (ctx) => stored.set((await store.row({ machine }, ctx))?.type),
			() => {},
		);
		const info = self.derive([named, stored, types], ([{ rows }, written, table]) => {
			const type = written ?? "";
			const status: Static<typeof MachineInfo>["status"] = table.has(type) ? "ready" : "unavailable";
			return { name: rows[0]?.name ?? "", type, status };
		});
		return { info };
	});
}

/** `input` with its type installed and its settings of that type's schema (a trust boundary: a create's input). */
function madeOf(input: MachineInput, types: ReadonlyMap<string, { readonly value: MachineType }>): MachineInput {
	const found = types.get(input.type)?.value;
	if (found === undefined) {
		throw invalid("args", `environments: no machine type ${input.type}`, {
			message: messages.message("noType", input.type),
		});
	}
	const wrong = checkValue(found.settings, input.settings);
	if (wrong !== undefined) {
		throw invalid("args", `environments: settings of ${input.type}: ${wrong}`, {
			message: messages.message("badSettings", wrong),
		});
	}
	return input;
}

/** Ends `connection`'s host once it connected (one that never connected has nothing to end); a failure is reported. */
function disconnect(connection: Connection): void {
	void connection.host.then(
		(host) =>
			host
				.close(BACKGROUND_CONTEXT)
				.catch((error: unknown) => reportError("environments: closing a machine", error, BACKGROUND_CONTEXT)),
		() => {},
	);
}
