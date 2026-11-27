// The machine kind's harness part (card 7), the one part that gives environments: the execution environment at a
// conversation's location, when the location names a machine the agent holds with Work here (this device's machine: a
// Node environment in the folder, on the machine the worker runs on), and the prompt section saying where the tools
// run. A location on a machine the agent does not hold, or holds without Work here, has no environment, and nothing
// falls back: the agent cannot run commands there. Exported for its test until the part is tested from the built
// facet with real references.

import { NodeExecutionEnv, type PromptSection } from "@earendil-works/p3/v1/worker";
import { thingHarnessPart } from "../things/contract.worker.ts";
import { MachineKind } from "./kind.ts";

/** The machine kind's part: the environment at a location on a held machine with Work here, and where tools run. */
export const machinePart = thingHarnessPart(MachineKind, (things, session) => {
	// Read at each use: a grant withheld calls the part anew, with the references as they are then.
	const working = (machine: string) => things.find((held) => held.thing === machine && held.ref.granted.has("work"));
	const where: PromptSection = {
		key: "machine",
		render: async ({ conversationId, env }, context) => {
			if (env === undefined) return "No machine is available here: commands cannot run.";
			const location = await session.location(conversationId, context);
			const held = location === undefined ? undefined : working(location.machine);
			return held === undefined ? undefined : `Tools run on ${held.ref.info.value.name}, in ${env.cwd}.`;
		},
	};
	return {
		env: (location) =>
			working(location.machine) === undefined ? undefined : new NodeExecutionEnv({ cwd: location.folder }),
		extension: { sections: [where] },
	};
});
