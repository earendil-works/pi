import { contribute, defineFacet } from "@p2/app/v1";
import { conversationRoute, Slots, useNavigation, useRoute } from "@p2/app/v1/web";

function ParentLink() {
	const nav = useNavigation();
	const route = useRoute();
	if (!route.session || (route.conversation ?? 1) === 1) return null;
	return (
		<button
			type="button"
			className="row-button"
			onClick={() => void nav.backOrPush(conversationRoute(route, route.session))}
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
