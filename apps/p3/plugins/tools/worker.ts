// The tools plugin on a session's worker: what the session's `tools.coding` things give the agent, Durable's coding
// tools on the session's location (read, write, edit, and bash). The tools act on the location, not on a thing, so
// several coding tools things give them once; bash is there when any of them has `shell` on (each such thing is
// someone's grant of a shell, and a thing that leaves it off grants the rest only, taking nothing away).

import { CodingTools, defineFacet } from "@earendil-works/p3/v1";
import { createCodingTools, ThingExtensions, thingExtension } from "@earendil-works/p3/v1/worker";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingExtensions,
		thingExtension(CodingTools, (things) => {
			const coding = createCodingTools();
			if (things.some(({ options }) => options.shell)) return { extension: coding };
			return { extension: { ...coding, tools: (coding.tools ?? []).filter((tool) => tool.name !== "bash") } };
		}),
	);
});
