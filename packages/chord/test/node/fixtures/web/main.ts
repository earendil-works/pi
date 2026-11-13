// The web entry of the browser tests (the base bundle): `startPage` with the tests' API modules and React, a core facet
// serving `Panels` and the counter, and a React app: the panels (`useRegistry`), a draft input (component state an
// in-place reload keeps), a counter held while shown (`useHold`, `useWatch`, `useRefState`), and a note in page state
// (`usePageState`) whose component the "remount" button replaces by another function, as a plugin reload does, a
// greeting in the page's language (`useMessages`), the core facet contributing its catalogs, the page's beats subscribed
// while shown (`useEvents`, its member and label switchable), and the plugins' parts (components). The page's reports and its client's stop are left on `globalThis` for the tests.

import * as React from "react";
import { createElement as h, useLayoutEffect, useState } from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import * as chord from "../../../../src/index.ts";
import {
	HostProvider,
	useEvents,
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
	/** What the beats' listener got, as `label:value`; emits a beat of member `a` or `b`; the beats' controls. */
	beats: string[];
	beat?: (member: "a" | "b", value: number) => void;
	relabel?: (label: string) => void;
	switchBeats?: () => void;
	toggleBeats?: () => void;
};
probe.loads = (probe.loads ?? 0) + 1;
probe.errors = [];
probe.beats = [];

const core = defineFacet((host, self) => {
	self.contribute(Translations, greetings.translations);
	host.serve(webApi.Panels, { compose: (table) => table.map(({ value }) => value) });
	host.serve(webApi.Parts, { compose: (table) => table.map(({ value }) => value) });
	host.serve(webApi.Beats, (_params, self) => {
		const a = self.events<number>();
		const b = self.events<number>();
		probe.beat = (member, value) => (member === "a" ? a : b).emit(value);
		return { a, b };
	});
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

/**
 * The beats: member `a` or `b` subscribed with a listener recording this render's label; a new label emits a beat of
 * `a` from a layout effect, before the render's passive effects run (the latest listener must get it).
 */
function Beats() {
	const ref = useHold(webApi.Beats, {});
	const [label, setLabel] = useState("first");
	const [member, setMember] = useState<"a" | "b">("a");
	probe.relabel = setLabel;
	probe.switchBeats = () => setMember((value) => (value === "a" ? "b" : "a"));
	useEvents(member === "a" ? ref?.a : ref?.b, ({ value }) => void probe.beats.push(`${label}:${value}`));
	useLayoutEffect(() => {
		if (label !== "first") probe.beat?.("a", 1);
	}, [label]);
	return h("span", { id: "beats", "data-member": member, "data-state": ref?.state.value.kind }, label);
}

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
	const [beats, setBeats] = useState(true);
	probe.toggleBeats = () => setBeats((value) => !value);
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
		beats ? h(Beats) : null,
	);
}

/**
 * Starts the page (Chord's package is free of side effects for bundlers: the entry calls this), with `options` among
 * `startPage`'s (`themes: false`).
 */
export function start(options: { readonly themes?: false } = {}): void {
	const started = startPage({
		...options,
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
