// What the sessions plugin's plugin-tier tests load beside it: the real server facets of the plugins its store reads
// (people, environments, apps, the coding app, sign-in), a test kind of thing without records whose entry a test
// changes live (`setNotes`: its version, its migration), as a reload of its plugin would; the notes test plugin (a
// kind with each person's own records), and a kind whose records throw.

import {
	contribute,
	defineFacet,
	defineThingKind,
	type JsonValue,
	obj,
	type P3Principal,
	type PluginFacet,
	str,
	type Writable,
} from "@earendil-works/p3/v1";
import { type ThingKindEntry, ThingKinds } from "@earendil-works/p3/v1/server";
import recordNotesServer from "../../../test/plugins/notes/server.ts";
import appsServer from "../../apps/server.ts";
import codingServer from "../../coding/server.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import signInServer from "../../sign-in/server.ts";

/** The test's kind of thing: notes in a colour. */
export const Notes = defineThingKind("test.notes", {
	version: 1,
	options: obj({ color: str() }),
	initial: { color: "red" },
});

/** The entry of `Notes` the stub contributes now; set by `setNotes`. */
let notes: Writable<ThingKindEntry> | undefined;

/** Contributes `entry` as the test kind's entry from now on (its plugin reloaded with another version). */
export function setNotes(entry: ThingKindEntry): void {
	notes!.set(entry);
}

/** The entry of `Notes` (version 1) with the title "Notes". */
export const NOTES: ThingKindEntry = { kind: Notes as ThingKindEntry["kind"], title: "Notes" };

/** The test kind's plugin: its entry in `ThingKinds`, a writable so a test changes it. */
const notesServer = defineFacet((host) => {
	contribute(host, "test.notes", (self) => {
		notes = self.writable(NOTES);
		self.contribute(ThingKinds, notes);
	});
});

/** A kind whose `records` throws: left out of what a writer may bring, and reported. */
const brokenRecordsServer = defineFacet((_host, self) => {
	self.contribute(ThingKinds, {
		kind: defineThingKind("broken.records", { version: 1, options: obj({}), initial: {} }) as ThingKindEntry["kind"],
		title: "Broken",
		records: async () => {
			throw new Error("no records today");
		},
	});
});

/** The facets the sessions plugin is tested beside. */
export const STUBS: readonly PluginFacet<P3Principal>[] = [
	{ name: "@earendil-works/p3-apps", facet: appsServer },
	{ name: "@earendil-works/p3-coding", facet: codingServer },
	{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	{ name: "@earendil-works/p3-people", facet: peopleServer },
	{ name: "@earendil-works/p3-sign-in", facet: signInServer },
	{ name: "p3-test-kind", facet: notesServer },
	{ name: "p3-test-notes", facet: recordNotesServer },
	{ name: "p3-test-broken-records", facet: brokenRecordsServer },
];

/** A version of `NOTES` at `version`, with `migrate` (none: no migration). */
export function notesAt(
	version: number,
	migrate?: (options: JsonValue, from: number) => { color: string } | undefined,
): ThingKindEntry {
	return { ...NOTES, kind: { ...NOTES.kind, version, ...(migrate === undefined ? {} : { migrate }) } };
}
