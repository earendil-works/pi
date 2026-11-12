// The subagents' web facet: the subagent tool's card and the conversation commands of the command menu (commands.tsx).
import { contribute, defineFacet } from "@p2/app/v1";
import { CommandPages, CommandSearches, Commands, ToolActivities } from "@p2/app/v1/web";
import { subagentActivity } from "./activity.tsx";
import { CONVERSATION_COMMANDS, CONVERSATION_PAGES, CONVERSATION_SEARCH } from "./commands.tsx";

export default defineFacet((host) => {
	contribute(host, "p2.web-subagents", (self) => {
		self.contribute(ToolActivities, { subagent: subagentActivity });
		self.contribute(Commands, CONVERSATION_COMMANDS);
		self.contribute(CommandPages, CONVERSATION_PAGES);
		self.contribute(CommandSearches, { conversations: CONVERSATION_SEARCH });
	});
});
