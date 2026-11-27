// The machine kind's harness part (card 7), the one part that gives environments: the execution environment at a
// conversation's location, when the location names a machine the agent holds with Work here, and the prompt section
// saying where the tools run. Only a ready machine of this device's type has one (a Node environment in the folder, on
// the machine the worker runs on); other types give theirs when they come (SSH, ERNDL-731). A location on a machine the
// agent does not hold, holds without Work here, or whose type is not installed, has no environment, and nothing falls
// back: the agent cannot run commands there. Exported for its test until the part is tested from the built
// facet with real references.

import { NodeExecutionEnv, type PromptSection } from "@earendil-works/p3/v1/worker";
import { thingHarnessPart } from "../things/contract.worker.ts";
import { THIS_DEVICE_TYPE } from "./contract.ts";
import { MachineKind } from "./kind.ts";

/**
 * The machine kind's part: the environment at a location on a ready machine of this device's type held with Work here,
 * and where tools run.
 */
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
		env: (location) => {
			const info = working(location.machine)?.ref.info.value;
			// Running a remote machine's commands here would run them on the wrong machine (Astra, round 5).
			if (info?.type !== THIS_DEVICE_TYPE || info.status !== "ready") return undefined;
			return new NodeExecutionEnv({ cwd: location.folder });
		},
		extension: { sections: [where] },
	};
});
