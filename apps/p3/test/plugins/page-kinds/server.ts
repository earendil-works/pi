// The page's test kinds on the server: nothing in them but their names.

import { defineFacet } from "@earendil-works/p3/v1";
import { serveThing } from "@earendil-works/p3/v1/server";
import { NoteKind, WallKind } from "./contract.ts";

export default defineFacet((host) => {
	serveThing(host, NoteKind, { implement: () => ({}) });
	serveThing(host, WallKind, { implement: () => ({}) });
});
