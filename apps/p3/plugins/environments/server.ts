// The environments plugin on the server: the machine kind (`serveThing`: the things plugin admits every caller,
// registers the kind and makes this device's machine in Pi once, its one thing), its host for server code
// (`MachineHosts`: Node's environment on this device, Pi's data folder hidden), the owner's list of machines
// (`Environments`) and this device's id for everyone signed in and every worker (`ThisDevice`).

import { homedir, hostname } from "node:os";
import { admitOwner, contribute, defineFacet, forbidden, type Self } from "@earendil-works/p3/v1";
import { NodeExecutionEnv, ServerRuntime } from "@earendil-works/p3/v1/server";
import { OneThing, ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { type MachineHost, MachineHosts } from "./contract.server.ts";
import { Environments, ThisDevice } from "./contract.ts";
import { MachineKind } from "./kind.ts";
import { messages } from "./messages.ts";

/** This device's machine: the machine kind's one thing. */
const THIS_DEVICE = { kind: MachineKind.name };

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

	serveThing(host, MachineKind, {
		one: { name: hostname() },
		implement: ({ thing }, _admitted, self) => ({ info: infoOf(thing, self) }),
	});

	contribute(host, "environments.this-device-host", (self) => {
		const device = self.get(OneThing, THIS_DEVICE);
		const runtime = self.registry(ServerRuntime);
		const local: MachineHost = {
			env: new NodeExecutionEnv({ cwd: homedir() }),
			hidden: [runtime.value.dataDir],
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

/** A machine's info: its thing's name, live, and its kind. */
function infoOf(thing: string, self: Self) {
	const named = self.liveQuery(self.get(ThingsStore, {}).things.one, { thing }, { first: 1 });
	return self.derive([named], ([{ rows }]) => ({ name: rows[0]?.name ?? "", kind: "local" as const }));
}
