// The history tools' web facet: how their calls show in the chat (activity.tsx).
import { contribute, defineFacet } from "@p2/app/v1";
import { ToolActivities } from "@p2/app/v1/web";
import { historyActivities } from "./activity.tsx";

export default defineFacet((host) => {
	contribute(host, "p2.web-history", (self) => {
		self.contribute(ToolActivities, historyActivities);
	});
});
