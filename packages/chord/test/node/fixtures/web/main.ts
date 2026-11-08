// The web entry of the browser tests (the base bundle): `startPage` with the tests' API modules and React, a core facet
// serving `Panels` and the counter, and a React app: the panels (`useRegistry`), a draft input (component state an
// in-place reload keeps), a counter held while shown (`useHold`, `useWatch`, `useRefState`), and a note in page state
// (`usePageState`) whose component the "remount" button replaces by another function, as a plugin reload does, a
// greeting in the page's language (`useMessages`), the core facet contributing its catalogs, and the plugins' parts
// (components). The page's reports and its client's stop are left on `globalThis` for the tests.

import * as React from "react";
import { createElement as h, useState } from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import * as chord from "../../../../src/index.ts";
import {
	HostProvider,
	useHold,
	useMessages,
	usePageState,
	useRefState,
	useRegistry,
	useWatch,
} from "../../../../src/react/index.ts";
import { startPage } from "../../../../src/web/index.ts";
import * as webApi from "./api.ts";

const { defineFacet, defineMessages, Translations } = chord;

/** The page's own messages. */
const greetings = defineMessages("test.page", {
	en: { hello: "Hello", count: (n: number) => (n === 1 ? "1 click" : `${n} clicks`) },
	de: { hello: "Hallo", count: (n) => (n === 1 ? "1 Klick" : `${n} Klicks`) },
});

/** What the tests read from the page. */
const probe = globalThis as unknown as {
	loads: number;
	counterState?: () => string | undefined;
	connection?: string;
	errors: chord.ClientError[];
	stop?: () => Promise<void>;
};
probe.loads = (probe.loads ?? 0) + 1;
probe.errors = [];

const core = defineFacet((host, self) => {
	self.contribute(Translations, greetings.translations);
	host.serve(webApi.Panels, { compose: (table) => table.map(({ value }) => value) });
	host.serve(webApi.Parts, { compose: (table) => table.map(({ value }) => value) });
	host.serve(webApi.Counter, (_params, self) => {
		const count = self.writable(0);
		return {
			count: self.derive([count], ([value]) => value),
			increment: async () => {
				count.set(count.value + 1);
				return null;
			},
		};
	});
});

function Counter() {
	const ref = useHold(webApi.Counter, {});
	const count = useWatch(ref?.count);
	const state = useRefState(ref);
	probe.counterState = () => ref?.state.value.kind;
	return h(
		"button",
		{
			type: "button",
			id: "count",
			"data-state": state?.kind,
			onClick: () => void ref?.increment(BACKGROUND_CONTEXT),
		},
		String(count ?? "…"),
	);
}

/** An input of the page state at `key`. */
function noteInput(key: string) {
	const [note, setNote] = usePageState(key, "");
	return h("input", {
		id: "note",
		"data-key": key,
		value: note,
		onChange: (event: { target: { value: string } }) => setNote(event.target.value),
	});
}

/** The note's component and the components replacing it: each a new function to React, as a reloaded plugin's. */
const NOTES = [() => noteInput("note"), () => noteInput("note"), () => noteInput("other")];

/** The greeting, in the page's language. */
function Greeting() {
	const { t, locale } = useMessages(greetings);
	return h("p", { id: "greeting", "data-locale": locale }, `${t("hello")}, ${t("count", 2)}`);
}

function App() {
	const panels = useRegistry(webApi.Panels) ?? [];
	const parts = useRegistry(webApi.Parts) ?? [];
	const [draft, setDraft] = useState("");
	const [shown, setShown] = useState(true);
	const [note, setNote] = useState(0);
	return h(
		"div",
		null,
		h("ul", { id: "panels" }, ...panels.map((panel) => h("li", { key: panel, className: "panel" }, panel))),
		// `Parts` holds components (its values are typed loosely: the API module declares no React types).
		h("div", { id: "parts" }, ...parts.map((part, index) => h(part as () => React.ReactNode, { key: index }))),
		h("input", {
			id: "draft",
			value: draft,
			onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
		}),
		h("button", { type: "button", id: "toggle", onClick: () => setShown((value) => !value) }, "toggle"),
		shown ? h(Counter) : null,
		h("button", { type: "button", id: "remount", onClick: () => setNote((value) => value + 1) }, "remount"),
		h(NOTES[note % NOTES.length]!),
		h(Greeting),
	);
}

/** Starts the page (Chord's package is free of side effects for bundlers: the entry calls this). */
export function start(): void {
	const started = startPage({
		connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
		modules: { "@test/app/v1": chord, "@test/app/v1/web": webApi, react: React, "react/jsx-runtime": jsx },
		core: [{ name: "@test/core", facet: core }],
		onConnection: (state) => {
			probe.connection = state;
		},
		render: (host) => createRoot(document.getElementById("root")!).render(h(HostProvider, { host }, h(App))),
		onError: (error) => {
			probe.errors.push(error);
			console.error("chord page:", error.kind);
		},
	});
	void started.then((client) => {
		probe.stop = () => client.stop(BACKGROUND_CONTEXT);
	});
}
