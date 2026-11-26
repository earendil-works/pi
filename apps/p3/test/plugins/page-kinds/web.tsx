// The page's test kinds on the page: their texts, their icons and the wall's view, which takes the whole page.

import { contribute, defineFacet, Translations } from "@earendil-works/p3/v1";
import { DescriptionIcon, EditIcon, ThingParts, type ThingViewProps, Views } from "@earendil-works/p3/v1/web";
import { useEffect } from "react";
import { messages, NoteKind, WallKind } from "./contract.ts";

export default defineFacet((host, self) => {
	self.contribute(Translations, messages.translations);
	self.contribute(ThingParts, { kind: NoteKind.name, Icon: DescriptionIcon });
	// One contribution per object and registry: the wall's parts come from an object of their own.
	contribute(host, WallKind.name, (wall) => wall.contribute(ThingParts, { kind: WallKind.name, Icon: EditIcon }));
	self.contribute(Views, {
		view: WallKind.name,
		title: messages.message("wall"),
		area: "page",
		for: { kind: "thing", thingKind: WallKind.name },
		View: Wall,
	});
});

/** The wall: a whole page of its own, with the thing's id on it; it counts its mounts for the page's test. */
function Wall(props: ThingViewProps) {
	useEffect(() => {
		const counted = window as unknown as { wallMounts?: number };
		counted.wallMounts = (counted.wallMounts ?? 0) + 1;
	}, []);
	return (
		<p data-wall={props.thing} style={{ margin: 0, padding: "4rem 2rem" }}>
			Wall
		</p>
	);
}
