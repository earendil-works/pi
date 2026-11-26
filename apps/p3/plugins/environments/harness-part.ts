// The machine kind's harness part (card 7): the execution environment at a conversation's location, when the location
// names a machine the agent holds with Work here (this device's machine: a Node environment in the folder, on the
// machine the worker runs on), and the prompt line saying where the tools run. A location on a machine the agent does
// not hold, or holds without Work here, has no environment: the agent cannot run commands there.

import { NodeExecutionEnv, type PromptSection } from "@earendil-works/p3/v1/worker";
import { type HeldThing, thingHarnessPart } from "../things/contract.worker.ts";
import { type Machine, MachineKind } from "./kind.ts";

/** The machine kind's part: the environment at a location on a held machine with Work here, and where tools run. */
export const machinePart = thingHarnessPart(MachineKind, (things) => {
	// Read at each use: a grant withheld calls the part anew, with the references as they are then.
	const working = (machine: string) => things.find((held) => held.thing === machine && held.ref.granted.has("work"));
	const where: PromptSection = {
		key: "machine",
		render: ({ env }) => {
			if (env === undefined) return "No machine is available here: commands cannot run.";
			const held = things.find((entry) => entry.ref.granted.has("work"));
			return held === undefined ? undefined : `Tools run on ${nameOf(held)}, in ${env.cwd}.`;
		},
	};
	return {
		env: (location) =>
			working(location.machine) === undefined ? undefined : new NodeExecutionEnv({ cwd: location.folder }),
		prompt: [where],
	};
});

/** A held machine's name, as its thing is named. */
function nameOf(held: HeldThing<typeof Machine>): string {
	return held.ref.info.value.name;
}
