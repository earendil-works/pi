// The one-shot agents' web facet: how their calls show in the chat (activity.tsx).
import { contribute, defineFacet } from "@p2/app/v1";
import { ToolActivities } from "@p2/app/v1/web";
import { agentActivity } from "./activity.tsx";

export default defineFacet((host) => {
	contribute(host, "p2.web-agent", (self) => {
		self.contribute(ToolActivities, { agent: agentActivity });
	});
});
