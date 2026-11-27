// The tools plugin on a session's worker: the harness part of the coding tools. The agent gets Durable's coding tools
// whose flag the nearest coding tools thing has (Read: `read`, Write: `write`, Edit: `edit`, Bash: `bash`). The kind
// stacks `nearest`: the nearest link's grants decide, so the part reads the last thing it gets. The tools act on the
// machine the agent works on, not on the thing. A tick withheld while a call runs: that call finishes; the next step
// has the tools anew without it.

import { defineFacet } from "@earendil-works/p3/v1";
import { createCodingTools } from "@earendil-works/p3/v1/worker";
import { type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { type CodingTools, CodingToolsKind } from "./kind.ts";

export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, thingHarnessPart(CodingToolsKind, codingTools));
});

/** What the nearest coding tools thing (held last: `stacking: "nearest"`) gives: Durable's tools of its flags. */
function codingTools(things: readonly HeldThing<typeof CodingTools>[]) {
	const nearest = things[things.length - 1];
	// The holding never calls a part with none; the list's type cannot say so.
	if (nearest === undefined) return {};
	// Each Durable tool is named as the flag tick that gives it. The grant as this list has it, not the reference's now.
	const tools = (createCodingTools().tools ?? []).filter((tool) => nearest.granted.has(tool.name));
	// Only the tools: the harness names the extension, and nothing else of Durable's extension rides along.
	return tools.length === 0 ? {} : { extension: { tools } };
}
