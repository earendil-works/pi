// The tools plugin on a session's worker: the harness part of the coding tools. The agent gets Durable's coding tools
// whose flag its reference to the coding tools has (Read: `read`, Write: `write`, Edit: `edit`, Bash: `bash`). The
// kind stacks `nearest`: the nearest link's grants decide, so the part reads the last thing it gets. The tools act on
// the machine the agent works on, not on the thing. A tick withheld while a call runs: that call finishes; the next
// step has the tools anew without it.

import { defineFacet } from "@earendil-works/p3/v1";
import { createCodingTools } from "@earendil-works/p3/v1/worker";
import { ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { CodingToolsKind } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, codingTools);
});

/** The coding tools' harness part (exported for its test). */
export const codingTools = thingHarnessPart(CodingToolsKind, (things) => {
	// Never called with none; the nearest is last.
	const nearest = things[things.length - 1];
	if (nearest === undefined) return {};
	const coding = createCodingTools();
	// Each Durable tool is named as the flag tick that gives it.
	const granted: ReadonlySet<string> = nearest.ref.granted;
	const tools = (coding.tools ?? []).filter((tool) => granted.has(tool.name));
	return tools.length === 0 ? {} : { extension: { ...coding, tools } };
});
