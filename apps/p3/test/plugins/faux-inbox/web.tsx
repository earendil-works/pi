// The faux inbox on the page, for tests only: its creation view (`ThingViews`' `Create`), one "Sign in" button that
// hands My things' "New thing" form a sign-in id, as a real inbox's view would after its sign-in.

import { Button } from "@earendil-works/elanor-react";
import { defineFacet } from "@earendil-works/p3/v1";
import { LinkIcon, type ThingCreateProps, ThingViews } from "@earendil-works/p3/v1/web";
import { FauxInboxKind } from "./contract.ts";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, { kind: FauxInboxKind.name, Icon: LinkIcon, Create: FauxInboxCreate }),
);

/** The creation step: a button standing in for a sign-in. */
function FauxInboxCreate(props: ThingCreateProps) {
	return (
		<Button data-faux-sign-in="" onClick={() => props.onReady({ signIn: "faux-sign-in" })}>
			Sign in
		</Button>
	);
}
