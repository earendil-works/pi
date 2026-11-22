// The apps plugin on the server: the `Apps` registry (each app's entry, by id), and who may enter which app. The owner
// enters every app; a person an app of one of their groups, or an app one of whose active sessions they are a member
// of (directly or through a group). `AppAccess` answers that for one app (an app's own objects admit with it),
// `AppCatalog` for every app at once. Whether a person is in an app's sessions is one live read per app and person
// (`AppEntered`); the catalog holds one per app in `Apps`, which changes at runtime (`entered.ts`).

import {
	AppAccess,
	type AppAdmission,
	AppCatalog,
	type AppInfo,
	callerKey,
	constant,
	defineFacet,
	forbidden,
	keyedEntries,
	type P3Principal,
	type TableItem,
} from "@earendil-works/p3/v1";
import { Apps, PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { AppEntered, followEntered } from "./entered.ts";

/**
 * How many groups of a person are read at most. Who reads more groups than that fails closed: their groups grant
 * nothing (the set that decides access is read whole or not at all).
 */
const GROUPS_READ = 1000;

export default defineFacet((host) => {
	host.serve(Apps, {
		compose: (table, { report }) => keyedEntries(table, (app) => ({ [app.id]: app }), report),
	});

	host.serve(AppEntered, ({ app, person }, self) => {
		const groups = self.liveQuery(self.get(PeopleStore, {}).groups.ofPerson, { person }, { first: GROUPS_READ });
		const args = self.derive([groups], ([{ rows, more }]) => ({
			app,
			members: [`person:${person}`, ...(more ? [] : rows.map(({ id }) => `group:${id}`))],
		}));
		// Index: the sessions plugin's (`memberships.active`); one row answers.
		const found = self.liveQuery(self.get(SessionsStore, {}).memberships.active, args, { first: 1 });
		return { entered: self.derive([found], ([{ rows }]) => rows.length > 0) };
	});

	host.serve(AppAccess, ({ app, caller }, principal, self) => {
		mayAsk(principal, caller);
		const apps = self.registry(Apps);
		if (caller === "owner") {
			const answer = self.derive([apps], ([table]) =>
				table.has(app) ? { kind: "owner" as const } : { kind: "none" as const },
			);
			return { variant: "answer", members: { answer } };
		}
		// The server and the workers are no one in an app; anything else that is no person neither.
		if (!caller.startsWith("person:")) return { variant: "answer", members: { answer: constant(NONE) } };
		const person = caller.slice("person:".length);
		const people = self.get(PeopleStore, {});
		const found = self.liveQuery(people.persons.one, { id: person }, { first: 1 });
		const groups = self.liveQuery(people.groups.ofPerson, { person }, { first: GROUPS_READ });
		const entered = self.get(AppEntered, { app, person }).entered;
		const answer = self.derive([apps, found, groups, entered], ([table, persons, theirs, inSession]) => {
			if (!table.has(app) || persons.rows.length === 0) return NONE;
			const names = theirs.more ? [] : theirs.rows.filter((group) => group.app === app).map(({ name }) => name);
			if (names.length === 0 && !inSession) return NONE;
			return { kind: "person" as const, id: person, groups: names } satisfies AppAdmission;
		});
		return { variant: "answer", members: { answer } };
	});

	host.serve(AppCatalog, (_params, principal, self) => {
		const apps = self.registry(Apps);
		if (principal.kind === "owner") {
			return { variant: "catalog", members: { apps: self.derive([apps], ([table]) => byTitle(table, () => true)) } };
		}
		if (principal.kind !== "person") throw forbidden("apps: the owner's and persons'");
		const person = principal.id;
		const groups = self.liveQuery(self.get(PeopleStore, {}).groups.ofPerson, { person }, { first: GROUPS_READ });
		const entered = followEntered(self, apps, (app, ctx) => ctx.get(AppEntered, { app, person }));
		const shown = self.derive([apps, groups, entered], ([table, theirs, inSessions]) => {
			const ofGroups = new Set(theirs.more ? [] : theirs.rows.map(({ app }) => app));
			return byTitle(table, (id) => ofGroups.has(id) || inSessions.has(id));
		});
		return { variant: "catalog", members: { apps: shown } };
	});
});

/** The answer for someone who may not enter. */
const NONE = { kind: "none" } as const;

/**
 * Refuses `principal` an answer about `caller` (`forbidden`): the server asks about anyone, a worker too (its
 * admissions ask for their callers), anyone else about themselves only.
 */
function mayAsk(principal: P3Principal, caller: string): void {
	if (principal.kind === "server" || principal.kind === "worker") return;
	if (callerKey(principal) !== caller) throw forbidden("apps: an answer about the caller only");
}

/** The apps of `table` that `shown` keeps, by title. */
function byTitle(table: ReadonlyMap<string, TableItem<AppInfo>>, shown: (id: string) => boolean): AppInfo[] {
	return [...table.values()]
		.map(({ value }) => value)
		.filter(({ id }) => shown(id))
		.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}
