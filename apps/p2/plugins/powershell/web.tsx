// PowerShell's web facet: how its calls show in the chat (activity.tsx).
import { contribute, defineFacet } from "@p2/app/v1";
import { ToolActivities } from "@p2/app/v1/web";
import { powershellActivity } from "./activity.tsx";
import { POWERSHELL_TOOL } from "./contract.ts";

export default defineFacet((host) => {
	contribute(host, "p2.web-powershell", (self) => {
		self.contribute(ToolActivities, { [POWERSHELL_TOOL]: powershellActivity });
	});
});
