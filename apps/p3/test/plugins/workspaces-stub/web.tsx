// The workspaces stub on the page, for tests only: its kinds' labels (`Translations`), their icons (`ThingParts`),
// and the wall's view, which takes the whole page (`area: "page"`).

import { contribute, defineFacet, defineMessages, Translations } from "@earendil-works/p3/v1";
import { DescriptionIcon, EditIcon, ThingParts, type ThingViewProps, Views } from "@earendil-works/p3/v1/web";

/** The stub's texts: its ticks' labels and the wall's title. */
const messages = defineMessages("workspaces-stub", {
	en: {
		read: "Read",
		write: "Write",
		link: "Link",
		hide: "Hide",
		configure: "Configure",
		managePeople: "Manage people",
		manageAccess: "Manage access",
		wall: "Wall",
	},
});

export default defineFacet((host, self) => {
	self.contribute(Translations, messages.translations);
	self.contribute(ThingParts, { kind: "workspaces-stub.note", Icon: DescriptionIcon });
	// One contribution per object and registry: the wall's parts come from an object of their own.
	contribute(host, "workspaces-stub.wall", (self) =>
		self.contribute(ThingParts, { kind: "workspaces-stub.wall", Icon: EditIcon }),
	);
	self.contribute(Views, {
		view: "workspaces-stub.wall",
		title: messages.message("wall"),
		area: "page",
		for: { kind: "thing", thingKind: "workspaces-stub.wall" },
		View: Wall,
	});
});

/** The wall: a whole page of its own, with the thing's id on it. */
function Wall(props: ThingViewProps) {
	return (
		<p data-wall={props.thing} style={{ margin: 0, padding: "4rem 2rem" }}>
			Wall
		</p>
	);
}
