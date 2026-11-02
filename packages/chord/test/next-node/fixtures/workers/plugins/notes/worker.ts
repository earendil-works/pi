// Fixture plugin (slice 10): the worker facet, serving `Notes` at the worker's address with the label of `label.ts`.

import { constant, defineFacet, hostKind, remote, str } from "@earendil-works/chord/next";
import { label } from "./label.ts";

const Session = hostKind("session", { id: str() });

const Notes = remote("test.notes", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { label: str() } } },
});

export default defineFacet((host) =>
	host.serve(Notes, ({ id }) => ({ variant: "main", members: { label: constant(`${id} ${label}`) } })),
);
