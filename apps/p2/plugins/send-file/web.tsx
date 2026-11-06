// The send_file tool's web facet: how its calls show in the chat (activity.tsx).
import { contribute, defineFacet } from "@p2/app/v1";
import { ToolActivities } from "@p2/app/v1/web";
import { sendFileActivity } from "./activity.tsx";

export default defineFacet((host) => {
	contribute(host, "p2.web-send-file", (self) => {
		self.contribute(ToolActivities, { send_file: sendFileActivity });
	});
});
