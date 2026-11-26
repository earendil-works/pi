// The page's entry (the base bundle the web surface builds from it at the first page request): Chord's page host with
// p3's web modules (the icons p3 offers among them), React and Elanor as the host packages web facets import, and the
// base's page facet, which serves the registries every page has (`PageRoot`, `PageConnection`, `Components`). It
// renders the one slot, `PageRoot`, which the chrome plugin fills; everything else on the page is a plugin. Light and
// dark follow the system through Elanor's tokens, so Chord's own themes are off.

import "./page.css";
import { startPage } from "@earendil-works/chord/web";
import * as Elanor from "@earendil-works/elanor-react";
import * as v1 from "@earendil-works/p3/v1";
import { type ConnectionState, contribute, defineFacet, keyedEntries, type P3Principal } from "@earendil-works/p3/v1";
import * as v1web from "@earendil-works/p3/v1/web";
import { Components, HostProvider, PageConnection, PageRoot, useRegistry } from "@earendil-works/p3/v1/web";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";

/** The connection's state, kept from the first report on: the page facet's object may go live after it. */
let connection: ConnectionState = "connecting";
let setConnection: ((state: ConnectionState) => void) | undefined;

/**
 * The base's page facet: `PageRoot` (the first by plugin name; a second is reported), `Components` (each
 * component's first contribution by plugin name) and `PageConnection`, which it contributes itself.
 */
const pageFacet = defineFacet((host) => {
	host.serve(PageRoot, {
		compose: ([first, ...others], { report }) => {
			for (const other of others) {
				report({ message: "a second page root is contributed", plugins: [first!.plugin, other.plugin] });
			}
			return first?.value;
		},
	});
	host.serve(Components, {
		compose: (table, { report }) =>
			keyedEntries(
				table,
				(entries) => Object.fromEntries(entries.map((entry) => [entry.token.name, entry])),
				report,
			),
	});
	host.serve(PageConnection, { compose: ([first]) => first?.value ?? "connecting" });
	contribute(host, "p3.page-connection", (self) => {
		const state = self.writable(connection);
		setConnection = (next) => state.set(next);
		self.contribute(PageConnection, state);
	});
});

/** The page: the chrome's root once its plugin loaded. */
function Root() {
	const Page = useRegistry(PageRoot);
	return Page === undefined ? null : <Page />;
}

void startPage<P3Principal>({
	connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
	modules: {
		"@earendil-works/p3/v1": v1,
		"@earendil-works/p3/v1/web": v1web,
		react: React,
		"react/jsx-runtime": jsx,
		"@earendil-works/elanor-react": Elanor,
	},
	core: [{ name: "p3.page", facet: pageFacet }],
	themes: false,
	onConnection: (state) => {
		connection = state;
		setConnection?.(state);
	},
	render: (host) => {
		// The entry's page template has the root element.
		createRoot(document.getElementById("root")!).render(
			<HostProvider host={host}>
				<Root />
			</HostProvider>,
		);
	},
});
