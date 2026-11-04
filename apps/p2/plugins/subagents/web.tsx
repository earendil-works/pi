import { contribute, defineFacet, liveIn } from "@p2/app/v1";
import { conversationRoute, Slots, useNavigation, useObject, useReadable, useRoute } from "@p2/app/v1/web";
import { Sessions } from "../sessions/contract.ts";

function ParentLink() {
	const nav = useNavigation();
	const route = useRoute();
	const rows = useReadable(liveIn(useObject(Sessions, {}), "owner", "guest")?.sessions);
	const main = rows?.find((row) => row.id === route.session)?.main;
	if (!route.session || main === undefined || route.conversation === main) return null;
	return (
		<button
			type="button"
			className="row-button"
			onClick={() => void nav.backOrPush(conversationRoute(route, route.session, main))}
		>
			Back to main conversation
		</button>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-subagents", (self) => {
		self.contribute(Slots, { "chat-parent": ParentLink });
	});
});
