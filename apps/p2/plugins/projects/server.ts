// Serves the owner's projects: one object for the server (`ProjectService`: the projects, the sessions' projects and the
// projects' coordinators, tables of the server's store (store.ts), `projects.json` imported into them once), `Projects`
// per owner with this device's label, the server's hostname, `ProjectCoordinators` for the owner, `CoordinatedProject`
// for workers, and a copy of a session (`/clone`, `/fork`) joining its source's project.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { bool, obj, str } from "@earendil-works/pi-schema";
import {
	type Context,
	contribute,
	defineFacet,
	defineState,
	deriveTyped,
	eq,
	forbidden,
	isOwner,
	isWorker,
	mapShared,
	query,
	record,
	type Tx,
} from "@p2/app/v1";
import { Hosts, Server, WorkerInitValues } from "@p2/app/v1/server";
import { Catalog, SessionCopied, SessionOperations } from "../sessions/contract.ts";
import { loadProjects, parsePlaces } from "./config.ts";
import {
	type ArchivedProject,
	COORDINATOR_INIT,
	CoordinatedProject,
	type Project,
	ProjectCoordinators,
	ProjectService,
	Projects,
} from "./contract.ts";
import { projectAt } from "./place.ts";
import { BY_POSITION, CoordinatorRows, MemberRows, type ProjectRow, ProjectRows } from "./store.ts";

type Place = Project["places"][number];

/** Whether projects.json and the earlier memberships were imported into the tables (once). */
const Imported = defineState("p2.projects-imported", {
	schema: obj({ imported: bool() }),
	version: 1,
	initial: () => ({ imported: false }),
	persist: true,
	checkpointWhen: () => true,
});

/** Where memberships lived before the tables: read once by the import, never written. */
const EarlierMemberships = defineState("p2.project-sessions", {
	schema: obj({ sessions: record(str()) }),
	version: 1,
	initial: () => ({ sessions: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});

/** The space between neighbouring projects' positions: a move between two takes the middle. */
const GAP = 1024;

/** The most rows kept live (a live query needs a bound); far more projects and sessions than a server has. */
const WINDOW = 100_000;

export default defineFacet((host) => {
	host.serve(ProjectService, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const operations = self.get(SessionOperations, {});
		const imported = self.state(Imported);
		const earlier = self.state(EarlierMemberships);
		const projectTable = self.table(ProjectRows);
		const memberTable = self.table(MemberRows);
		const projectRows = self.query(projectTable, BY_POSITION, WINDOW);
		const memberRows = self.query(memberTable, query(MemberRows), WINDOW);
		const coordinatorTable = self.table(CoordinatorRows);
		const coordinatorRows = self.query(coordinatorTable, query(CoordinatorRows), WINDOW);
		const coordinators = self.derive([coordinatorRows], ([rows]) =>
			Object.fromEntries(rows.map((row) => [row.project, row.session])),
		);
		const toProject = mapShared((row: ProjectRow): Project => ({ name: row.name, places: row.places }));
		const toArchived = mapShared(
			(row: ProjectRow): ArchivedProject => ({
				name: row.name,
				places: row.places,
				archivedAt: row.archivedAt ?? 0,
			}),
		);
		// The first catalog answers the import: a session that joined no project goes to the one whose place holds its
		// folder, as the sidebar showed it, so the sidebar looks the same afterwards.
		self.on(catalog.sessions, async ({ value: sessions }, ctx) => {
			if (imported.value.imported) return;
			// An unreadable projects.json imports nothing: p2 started without its projects then too.
			const file = await loadProjects(server.info.value.dataDir).catch((): Project[] => []);
			await self.tx(async (tx) => {
				let position = await lastPosition(tx);
				for (const project of file) {
					if (await tx.get(projectTable, { name: project.name })) continue;
					position += GAP;
					tx.put(projectTable, { ...project, position, archivedSessions: [] });
				}
				const known = new Set(file.map((project) => project.name));
				for (const session of sessions) {
					const name = projectAt(file, session.env ?? null, session.cwd, earlier.value.sessions[session.id])?.name;
					if (name !== undefined && known.has(name) && !(await tx.get(memberTable, { session: session.id })))
						tx.put(memberTable, { session: session.id, project: name });
				}
			}, ctx);
			await imported.change((draft) => {
				draft.imported = true;
			}, ctx);
		});
		const lastPosition = async (tx: Tx) => {
			let last = 0;
			for await (const row of tx.rows(projectTable, BY_POSITION)) last = row.position;
			return last;
		};
		const named = async (tx: Tx, name: string) => {
			const row = await tx.get(projectTable, { name });
			if (!row) throw new Error(`No project "${name}"`);
			return row;
		};
		const live = async (tx: Tx, name: string) => {
			const row = await named(tx, name);
			if (row.archivedAt !== undefined) throw new Error(`Project "${name}" is archived`);
			return row;
		};
		const membersOf = async (tx: Tx, name: string) => {
			const sessions: string[] = [];
			for await (const row of tx.rows(
				memberTable,
				query(MemberRows).where((each) => eq(each.project, name)),
			))
				sessions.push(row.session);
			return sessions;
		};
		/** A free name for a project (not `except`'s): trimmed and checked as projects.json's names were. */
		const freeName = async (tx: Tx, name: string, except?: string) => {
			const trimmed = name.trim();
			parsePlaces(trimmed, [{ path: "/" }]);
			if (trimmed !== except && (await tx.get(projectTable, { name: trimmed })))
				throw new Error(`A project "${trimmed}" exists already`);
			return trimmed;
		};
		const checkedPlace = (name: string, place: Place): Place =>
			parsePlaces(name, [
				place.env === null ? { path: place.path.trim() } : { env: place.env, path: place.path.trim() },
			])[0]!;
		const write = (apply: (tx: Tx) => Promise<void>, ctx: Context) => self.tx(apply, ctx).then(() => null);
		/** The project `session` coordinates, if it is a coordinator. */
		const coordinated = async (tx: Tx, session: string) => {
			for await (const row of tx.rows(
				coordinatorTable,
				query(CoordinatorRows).where((each) => eq(each.session, session)),
			))
				return row.project;
			return undefined;
		};
		/**
		 * The project's coordinator, its ID chosen and joined to the project before its row is made (a crash in between
		 * makes the same session on the next open); made at the default place, or restored when archived.
		 */
		const openOnce = async (name: string, ctx: Context) => {
			const { id, place } = await self.tx(async (tx) => {
				const project = await live(tx, name);
				const place = project.places[0];
				if (!place) throw new Error(`Project "${name}" has no place`);
				const chosen = await tx.get(coordinatorTable, { project: name });
				if (chosen) return { id: chosen.session, place };
				const fresh = randomUUID();
				tx.put(coordinatorTable, { project: name, session: fresh });
				tx.put(memberTable, { session: fresh, project: name });
				return { id: fresh, place };
			}, ctx);
			const row = catalog.sessions.value.find((session) => session.id === id);
			// A chosen ID makes the row once (`create` answers a retry with the existing row).
			if (!row) await operations.create({ id, env: place.env, cwd: place.path, title: `${name} coordinator` }, ctx);
			else if (row.archivedAt !== null) await operations.restore({ id }, ctx);
			return { id };
		};
		let opening: Promise<unknown> = Promise.resolve();
		self.contribute(WorkerInitValues, {
			[COORDINATOR_INIT]: (session) => Object.values(coordinators.value).includes(session),
		});
		return {
			projects: deriveTyped(self, [projectRows], ([rows]) =>
				toProject(rows.filter((row) => row.archivedAt === undefined)),
			),
			archived: deriveTyped(self, [projectRows], ([rows]) =>
				toArchived(rows.filter((row) => row.archivedAt !== undefined)).toSorted(
					(a, b) => b.archivedAt - a.archivedAt,
				),
			),
			sessions: self.derive([memberRows], ([rows]) =>
				Object.fromEntries(rows.map((row) => [row.session, row.project])),
			),
			coordinators,
			assign: ({ session, project }, ctx) =>
				write(async (tx) => {
					const coordinates = await coordinated(tx, session);
					if (coordinates !== undefined && coordinates !== project)
						throw new Error(`The coordinator of "${coordinates}" stays in its project`);
					if (project === null) return tx.delete(memberTable, { session });
					await live(tx, project);
					tx.put(memberTable, { session, project });
				}, ctx),
			copy: ({ source, copy }, ctx) =>
				write(async (tx) => {
					const member = await tx.get(memberTable, { session: source });
					if (member) tx.put(memberTable, { session: copy, project: member.project });
				}, ctx),
			create: ({ name, place }, ctx) =>
				write(async (tx) => {
					const free = await freeName(tx, name);
					const places = [checkedPlace(free, place)];
					tx.put(projectTable, {
						name: free,
						places,
						position: (await lastPosition(tx)) + GAP,
						archivedSessions: [],
					});
				}, ctx),
			rename: ({ name, to }, ctx) =>
				write(async (tx) => {
					const row = await named(tx, name);
					const free = await freeName(tx, to, name);
					if (free === name) return;
					tx.delete(projectTable, { name });
					tx.put(projectTable, { ...row, name: free });
					for (const session of await membersOf(tx, name)) tx.put(memberTable, { session, project: free });
					const coordinator = await tx.get(coordinatorTable, { project: name });
					if (coordinator) {
						tx.delete(coordinatorTable, { project: name });
						tx.put(coordinatorTable, { project: free, session: coordinator.session });
					}
				}, ctx),
			locate: ({ name, place }, ctx) =>
				write(async (tx) => {
					const row = await named(tx, name);
					const checked = checkedPlace(name, place);
					tx.put(projectTable, {
						...row,
						places: [checked, ...row.places.filter((each) => each.env !== checked.env)],
					});
				}, ctx),
			move: ({ name, before }, ctx) =>
				write(async (tx) => {
					const row = await live(tx, name);
					if (before === name) return;
					const order: ProjectRow[] = [];
					for await (const each of tx.rows(projectTable, BY_POSITION)) if (each.name !== name) order.push(each);
					const at = before === null ? order.length : order.findIndex((each) => each.name === before);
					if (at === -1) throw new Error(`No project "${before}"`);
					const after = order[at - 1]?.position;
					const next = order[at]?.position;
					const position =
						after === undefined
							? (next ?? GAP) - GAP
							: next === undefined
								? after + GAP
								: Math.floor((after + next) / 2);
					// Halving a gap runs out after about ten moves into one spot: then the order is numbered anew.
					if (position === after || position === next) {
						order.splice(at, 0, row);
						for (const [index, each] of order.entries())
							tx.put(projectTable, { ...each, position: (index + 1) * GAP });
					} else tx.put(projectTable, { ...row, position });
				}, ctx),
			archive: async ({ name }, ctx) => {
				const members = new Set(await self.tx((tx) => live(tx, name).then(() => membersOf(tx, name)), ctx));
				const sessions = catalog.sessions.value.filter(
					(session) => session.archivedAt === null && members.has(session.id),
				);
				for (const session of sessions) await operations.archive({ id: session.id }, ctx);
				return write(async (tx) => {
					const row = await live(tx, name);
					tx.put(projectTable, {
						...row,
						archivedAt: Date.now(),
						archivedSessions: sessions.map((session) => session.id),
					});
				}, ctx);
			},
			restore: async ({ name }, ctx) => {
				const row = await self.tx((tx) => named(tx, name), ctx);
				if (row.archivedAt === undefined) return null;
				const archived = new Set(row.archivedSessions);
				for (const session of catalog.sessions.value)
					if (archived.has(session.id) && session.archivedAt !== null)
						await operations.restore({ id: session.id }, ctx);
				// Back after the live projects: it had left the order the owner sees.
				return write(async (tx) => {
					const { archivedAt: _archived, ...current } = await named(tx, name);
					tx.put(projectTable, { ...current, archivedSessions: [], position: (await lastPosition(tx)) + GAP });
				}, ctx);
			},
			remove: async ({ name }, ctx) => {
				// Its coordinator has nothing left to coordinate: archived first, so a failure leaves the project as it was.
				const coordinator = await self.tx(
					(tx) => named(tx, name).then(() => tx.get(coordinatorTable, { project: name })),
					ctx,
				);
				const session = coordinator && catalog.sessions.value.find((each) => each.id === coordinator.session);
				if (session && session.archivedAt === null) await operations.archive({ id: session.id }, ctx);
				return write(async (tx) => {
					await named(tx, name);
					tx.delete(projectTable, { name });
					tx.delete(coordinatorTable, { project: name });
					for (const session of await membersOf(tx, name)) tx.delete(memberTable, { session });
				}, ctx);
			},
			open: ({ name }, ctx) => {
				// An earlier open's failure was its caller's answer; this one starts afresh.
				const next = opening.catch(() => undefined).then(() => openOnce(name, ctx));
				opening = next;
				return next;
			},
		};
	});

	host.serve(Projects, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("projects are owner-only");
		const service = self.get(ProjectService, {});
		const label = hostname();
		return {
			projects: service.projects,
			archived: service.archived,
			// A constant: a derive of no sources.
			local: self.derive([], () => label),
			sessions: service.sessions,
			assign: (args, ctx) => service.assign(args, ctx),
			create: (args, ctx) => service.create(args, ctx),
			rename: (args, ctx) => service.rename(args, ctx),
			locate: (args, ctx) => service.locate(args, ctx),
			move: (args, ctx) => service.move(args, ctx),
			archive: (args, ctx) => service.archive(args, ctx),
			restore: (args, ctx) => service.restore(args, ctx),
			remove: (args, ctx) => service.remove(args, ctx),
		};
	});

	host.serve(ProjectCoordinators, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("project coordinators are the owner's");
		const service = self.get(ProjectService, {});
		return {
			sessions: service.coordinators,
			open: (args, ctx) => service.open(args, ctx),
		};
	});

	host.serve(CoordinatedProject, (_params, principal, self) => {
		if (!isWorker(principal)) throw forbidden("for session workers");
		const service = self.get(ProjectService, {});
		const hosts = self.get(Hosts, {});
		return {
			project: async () => {
				const current = hosts.workers.value[principal.session];
				if (!current?.running || current.generation !== principal.generation) throw forbidden("stale worker");
				const entry = Object.entries(service.coordinators.value).find(
					([, session]) => session === principal.session,
				);
				return entry?.[0] ?? null;
			},
		};
	});

	// A copy keeps its source's project; the copy goes on if that cannot be recorded.
	contribute(host, "p2.projects-copied", (self) => {
		const service = self.get(ProjectService, {});
		self.contribute(SessionCopied, {
			projects: (source, copy, ctx) =>
				service
					.copy({ source, copy }, ctx)
					.then(() => {})
					.catch((error: unknown) => console.error(`p2 projects: session ${copy} kept no project:`, error)),
		});
	});
});
