// The environments plugin on a session's worker: the machine kind's harness part (card 7), the one part that gives
// environments: the execution environment at a conversation's location, when the location names a machine the agent
// holds with Work here, and the prompt section saying where the tools run. Only a ready machine of this device's type
// has one (a Node environment in the folder, on the machine the worker runs on); other types give theirs when they come
// (SSH, ERNDL-731). A location on a machine the agent does not hold, holds without Work here, or whose type is not
// installed, has no environment, and nothing falls back: the agent cannot run commands there. Its tool,
// `location_move`, moves the agent's conversation to a folder on a machine it holds (by id or a unique name); the
// server refuses a machine without Work here and a folder that is not a full path.

import { defineFacet, invalid, obj, str } from "@earendil-works/p3/v1";
import { defineTool, NodeExecutionEnv, type PromptSection } from "@earendil-works/p3/v1/worker";
import { type HarnessSession, type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { THIS_DEVICE_TYPE } from "./contract.ts";
import { type Machine, MachineKind } from "./kind.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, machinePart);
});

/**
 * The machine kind's part: the environment at a location on a ready machine of this device's type held with Work here,
 * where tools run, and the tool that moves a conversation.
 */
const machinePart = thingHarnessPart(MachineKind, (things, session) => {
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
		extension: { sections: [where], tools: [moveTool(things, session)] },
	};
});

/** The tool `location_move`: moves the calling conversation to a folder on one of the machines held. */
function moveTool(things: readonly HeldThing<typeof Machine>[], session: HarnessSession) {
	return defineTool({
		name: "location_move",
		description:
			"Moves this conversation to `folder` (a full path) on `machine` (a machine's id, or its name when no other " +
			"machine here has it): your next tool calls run there, a call under way stays where it started. Answers " +
			"JSON `{ machine, folder }` with the machine's id. Refused for a machine you may not work on.",
		parameters: obj({ machine: str({ min: 1, max: 200 }), folder: str({ min: 1, max: 4096 }) }),
		execute: async ({ machine, folder }, api, context) => {
			const id = machineNamed(things, machine);
			// The server checks Work here and the full path, with the message the agent reads.
			await session.moveLocation(api.conversationId, { machine: id, folder }, context);
			return { output: [{ type: "text" as const, text: JSON.stringify({ machine: id, folder }) }] };
		},
	});
}

/** The id of the held machine `named` names: its id, or a name only one of them has; refused otherwise. */
function machineNamed(things: readonly HeldThing<typeof Machine>[], named: string): string {
	if (things.some((held) => held.thing === named)) return named;
	// One machine may be held in several workspaces of the line: counted once.
	const found = [...new Set(things.filter((held) => held.ref.info.value.name === named).map((held) => held.thing))];
	if (found.length === 1) return found[0]!;
	throw invalid(
		"args",
		found.length === 0
			? `location_move: no machine ${named} here`
			: `location_move: ${named} names ${found.length} machines here: give its id`,
	);
}
