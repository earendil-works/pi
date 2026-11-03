import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contribute, defineFacet, deriveTyped, forbidden, isGuest, isOwner, isWorker } from "@p2/app/v1";
import { Hosts, Server, WorkerInitValues } from "@p2/app/v1/server";
import { Catalog, type Session } from "../sessions/contract.ts";
import { type Child, ChildStore, Subagents } from "./contract.ts";

/** A child as an older version stored it: its own cwd without the environment. */
type StoredChild = Child & { cwd?: string };

/**
 * A stored child in the current form: an own cwd stored before locations existed is on the session's environment (a
 * session could not change machines while it had subagents with their own cwd).
 */
function placed({ cwd, ...child }: StoredChild, session: Session | undefined): Child {
	if (cwd === undefined || child.location !== undefined) return child;
	return { ...child, location: { cwd, env: session?.env ?? null } };
}

export default defineFacet((host) => {
	host.serve(ChildStore, (_params, self) => {
		const server = self.get(Server, {});
		const hosts = self.get(Hosts, {});
		const catalog = self.get(Catalog, {});
		// Every session's children, read when the database opens: rows stored with an own cwd (version 1) are placed, and
		// saved so, at that first read.
		const children = self.writable<Record<string, Child[]>>({});
		const dbResource = self.open(
			async () => {
				const path = join(server.info.value.dataDir, "subagents.sqlite");
				const db = new DatabaseSync(path);
				chmodSync(path, 0o600);
				db.exec(
					"PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS children(session TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
				);
				const sessions = new Map(catalog.sessions.value.map((session) => [session.id, session]));
				const read: Record<string, Child[]> = {};
				for (const row of db.prepare("SELECT session,value FROM children").all()) {
					const session = String(row.session);
					const stored = JSON.parse(String(row.value)) as StoredChild[];
					read[session] = stored.map((child) => placed(child, sessions.get(session)));
					if (stored.some((child) => child.cwd !== undefined))
						db.prepare("UPDATE children SET value=? WHERE session=?").run(JSON.stringify(read[session]), session);
				}
				children.set(read);
				return db;
			},
			(db) => db.close(),
		);
		const save = (session: string, saved: readonly Child[]): void => {
			dbResource.value
				.prepare(
					"INSERT INTO children(session,value) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET value=excluded.value",
				)
				.run(session, JSON.stringify(saved));
		};
		return {
			children: deriveTyped(self, [children], ([value]) => value),
			report: async ({ session, generation, children: reported }) => {
				const worker = hosts.workers.value[session];
				if (!worker?.running || worker.generation !== generation) return null;
				save(session, reported);
				children.set({ ...children.value, [session]: reported });
				return null;
			},
		};
	});

	// A worker places own cwds stored before locations existed on the environment recorded here.
	contribute(host, "p2.subagents-init", (self) => {
		const store = self.get(ChildStore, {});
		self.contribute(WorkerInitValues, {
			subagentLocations: async (session) => {
				return Object.fromEntries(
					(store.children.value[session] ?? []).flatMap((child) =>
						child.location === undefined ? [] : [[String(child.conversationId), child.location]],
					),
				);
			},
		});
	});

	host.serve(Subagents, (_params, principal, self) => {
		const store = self.get(ChildStore, {});
		if (isWorker(principal)) {
			const { session, generation } = principal;
			return {
				variant: "reporter",
				members: { report: ({ children }, ctx) => store.report({ session, generation, children }, ctx) },
			};
		}
		if (isGuest(principal)) {
			const children = deriveTyped(self, [store.children], ([value]) =>
				Object.fromEntries(Object.keys(principal.sessions).map((session) => [session, value[session] ?? []])),
			);
			return { variant: "reader", members: { children } };
		}
		if (!isOwner(principal)) throw forbidden("owners and guests only");
		return { variant: "reader", members: { children: store.children } };
	});
});
