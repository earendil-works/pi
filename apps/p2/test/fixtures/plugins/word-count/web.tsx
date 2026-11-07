// The web facet: contributes the tool's look, keyed by its name.
import { contribute, defineFacet } from "@p2/app/v1";
import { ToolActivities } from "@p2/app/v1/web";
import { wordCountActivity } from "./activity.tsx";

export default defineFacet((host) => {
	contribute(host, "p2.web-word-count", (self) => {
		self.contribute(ToolActivities, { word_count: wordCountActivity });
	});
});
