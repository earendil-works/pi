// A read-only report of what a p2 data directory holds, to check that nothing was lost across a deploy that changes
// no data (the move to Chord v2) or across `npm run migrate-data` (it reads either layout): sessions with their conversations and newest entries, subagents, shares, artifacts,
// uploads and downloads, and the names of environments and port forwards. Never secrets: no tokens, cookies, keys,
// forward addresses or message text. Every SQLite file is opened read-only, so it runs beside a live server.
//
//   node --import ./src/source.ts scripts/data-report.ts [--data <dir>] > before.json
//   node --import ./src/source.ts scripts/data-report.ts [--data <dir>] --compare before.json
//
// `--compare` prints each difference as `path: before -> after` and exits 1 if there is one.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** What the report says about one session. */
export type SessionReport = {
	readonly title: string;
	/** `env:cwd` on an SSH environment, else the cwd. */
	readonly location: string;
	readonly archived: boolean;
	/** The catalog's last activity (ms since the epoch). */
	readonly updatedAt: number;
	/** Per conversation ID: its number of entries and its newest entry ID. */
	readonly conversations: Readonly<Record<string, { readonly entries: number; readonly newest: number }>>;
	readonly subagents: readonly { readonly name: string; readonly location?: string; readonly archived: boolean }[];
	/** The modes of its share links, and of the guests' grants (removed ones left out). */
	readonly shares: { readonly links: readonly string[]; readonly guests: readonly string[] };
	/** Per artifact name, its versions. */
	readonly artifacts: Readonly<Record<string, number>>;
	readonly uploads: number;
	readonly downloads: number;
};

export type DataReport = {
	readonly sessions: Readonly<Record<string, SessionReport>>;
	readonly envs: readonly string[];
	readonly forwards: readonly { readonly port: number; readonly name?: string; readonly public: boolean }[];
};

/** Reports the data directory `dataDir`. */
export function dataReport(dataDir: string): DataReport {
	const catalog = catalogRows(dataDir);
	const children = new Map(
		childRows(dataDir).map((row) => [String(row.session), JSON.parse(String(row.value)) as StoredChild[]]),
	);
	const shares = sharesBySession(dataDir);
	const sessions: Record<string, SessionReport> = {};
	for (const row of catalog) {
		const id = String(row.id);
		sessions[id] = {
			title: String(row.title),
			location: located(row.env === null ? null : String(row.env), String(row.cwd)),
			archived: row.archivedAt !== null,
			updatedAt: Number(row.updatedAt),
			conversations: conversationsOf(dataDir, id),
			subagents: (children.get(id) ?? [])
				.filter((child) => child.kind !== "agent")
				.map((child) => ({
					name: child.name,
					...(child.location
						? { location: located(child.location.env, child.location.cwd) }
						: child.cwd === undefined
							? {}
							: { location: child.cwd }),
					archived: child.archived === true,
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
			shares: shares.get(id) ?? { links: [], guests: [] },
			...filesOf(dataDir, id),
		};
	}
	return {
		sessions,
		envs: Object.keys(jsonFile(join(dataDir, "envs.json")) ?? {}).sort(),
		forwards: Object.values((jsonFile(join(dataDir, "forwards.json")) ?? {}) as Record<string, StoredForward>)
			.map((forward) => ({
				port: forward.port,
				...(forward.name === undefined ? {} : { name: forward.name }),
				public: forward.public === true,
			}))
			.sort((a, b) => a.port - b.port),
	};
}

/** A `ChildStore` row as `subagents.sqlite` keeps it (version 1 rows have an own `cwd`, later ones a `location`). */
type StoredChild = {
	readonly name: string;
	readonly kind?: "agent";
	readonly archived?: boolean;
	readonly cwd?: string;
	readonly location?: { readonly env: string | null; readonly cwd: string };
};

type StoredForward = { readonly port: number; readonly name?: string; readonly public?: boolean };

type Row = Record<string, unknown>;

/** The rows of `sql` in the SQLite file `path`, opened read-only; none when the file does not exist. */
function rows(path: string, sql: string): Row[] {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all() as Row[];
	} catch (error) {
		// A store whose owner never made its table (a session that never wrote a file) holds none of its rows.
		if (error instanceof Error && error.message.includes("no such table")) return [];
		throw error;
	} finally {
		db.close();
	}
}

const located = (env: string | null, cwd: string): string => (env ? `${env}:${cwd}` : cwd);

/**
 * The catalog's rows, `id` first, in either layout: the server store's table (`p2.catalog:sessions`, keyed by the
 * session's address, `session|<id>`) once p2 imported it, else `catalog.sqlite` as p2 kept it before.
 */
function catalogRows(dataDir: string): Row[] {
	const columns = "title,cwd,env,updatedAt,archivedAt";
	const stored = rows(
		join(dataDir, "server", "store.sqlite"),
		`SELECT substr(session, 9) AS id,${columns} FROM "p2.catalog:sessions" ORDER BY id`,
	);
	return stored.length > 0
		? stored
		: rows(join(dataDir, "catalog.sqlite"), `SELECT id,${columns} FROM sessions ORDER BY id`);
}

/**
 * Each session's stored subagents, in either layout: `p2.child-store`'s table in the server's store, else
 * `subagents.sqlite`.
 */
function childRows(dataDir: string): Row[] {
	const stored = rows(
		join(dataDir, "server", "store.sqlite"),
		'SELECT substr(session, 9) AS session,children AS value FROM "p2.child-store:children"',
	);
	return stored.length > 0 ? stored : rows(join(dataDir, "subagents.sqlite"), "SELECT session,value FROM children");
}

/**
 * The links' and the current guests' modes of every shared session, in either layout. Version 1 of `shares.sqlite` (one session per
 * guest, through its link) reports as version 2's grants do, so a report from before its migration compares equal.
 */
function sharesBySession(dataDir: string): Map<string, { links: string[]; guests: string[] }> {
	const shares = new Map<string, { links: string[]; guests: string[] }>();
	const of = (session: string) => {
		const entry = shares.get(session) ?? { links: [], guests: [] };
		shares.set(session, entry);
		return entry;
	};
	// In the server's store once p2 moved them there (`p2.shares`' tables, a session as its address key `session|<id>`).
	const store = join(dataDir, "server", "store.sqlite");
	const links = rows(store, 'SELECT substr(session, 9) AS session,mode FROM "p2.shares:links" ORDER BY session,mode');
	if (links.length > 0) {
		for (const row of links) of(String(row.session)).links.push(String(row.mode));
		for (const row of rows(
			store,
			'SELECT substr(session, 9) AS session,mode FROM "p2.shares:grants" WHERE removed=0 ORDER BY session,mode',
		))
			of(String(row.session)).guests.push(String(row.mode));
		return shares;
	}
	const path = join(dataDir, "shares.sqlite");
	for (const row of rows(path, "SELECT session,mode FROM links ORDER BY session,mode"))
		of(String(row.session)).links.push(String(row.mode));
	const grants = rows(path, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='grants'").length
		? "SELECT session,mode FROM grants WHERE removed=0 ORDER BY session,mode"
		: "SELECT session,mode FROM guests JOIN links ON links.id=guests.linkId WHERE removed=0 ORDER BY session,mode";
	for (const row of rows(path, grants)) of(String(row.session)).guests.push(String(row.mode));
	return shares;
}

/** A session's store in the layout before per-host stores (`sessions/<id>.sqlite`), when it is still there. */
const oldStore = (dataDir: string, id: string): string => join(dataDir, "sessions", `${id}.sqlite`);

/** A session's store (`sessions/<id>/store.sqlite`). */
const sessionStore = (dataDir: string, id: string): string => join(dataDir, "sessions", id, "store.sqlite");

/**
 * A session's conversations from its Durable records: entries and the newest entry ID of each. Either layout, so a
 * report from before the migration compares with one after it.
 */
function conversationsOf(dataDir: string, id: string): Record<string, { entries: number; newest: number }> {
	const conversations: Record<string, { entries: number; newest: number }> = {};
	const [path, table] = existsSync(oldStore(dataDir, id))
		? [oldStore(dataDir, id), "entries"]
		: [sessionStore(dataDir, id), '"p2.durable:entries"'];
	for (const row of rows(
		path,
		`SELECT conversation_id AS id, count(*) AS entries, max(id) AS newest FROM ${table} GROUP BY conversation_id ORDER BY conversation_id`,
	))
		conversations[String(row.id)] = { entries: Number(row.entries), newest: Number(row.newest) };
	return conversations;
}

/**
 * A session's artifacts (versions per name), uploads and downloads: from the directories of the old layout while its
 * old store is there, else from the session's `Files` index.
 */
function filesOf(
	dataDir: string,
	id: string,
): { artifacts: Record<string, number>; uploads: number; downloads: number } {
	if (existsSync(oldStore(dataDir, id)))
		return {
			artifacts: artifactsOf(join(dataDir, "artifacts", id)),
			uploads: entriesIn(join(dataDir, "uploads", id)).length,
			downloads: entriesIn(join(dataDir, "downloads", id)).filter((download) =>
				existsSync(join(dataDir, "downloads", id, download, "metadata.json")),
			).length,
		};
	const files = rows(sessionStore(dataDir, id), 'SELECT space, path FROM "chord.app.files:files" ORDER BY path');
	const artifacts: Record<string, number> = {};
	for (const row of files.filter((file) => file.space === "artifacts"))
		artifacts[String(row.path)] = (artifacts[String(row.path)] ?? 0) + 1;
	return {
		artifacts,
		uploads: files.filter((file) => file.space === "uploads").length,
		downloads: files.filter((file) => file.space === "downloads").length,
	};
}

/** The artifacts of a session's directory (`<name>/<version>/version.json`): their number of versions. */
function artifactsOf(directory: string): Record<string, number> {
	const artifacts: Record<string, number> = {};
	for (const name of entriesIn(directory))
		artifacts[name] = entriesIn(join(directory, name)).filter((version) =>
			existsSync(join(directory, name, version, "version.json")),
		).length;
	return artifacts;
}

/** The names in `directory` (sorted, temporary files left out), none when it does not exist. */
function entriesIn(directory: string): string[] {
	if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
	return readdirSync(directory)
		.filter((name) => !name.startsWith("."))
		.sort();
}

function jsonFile(path: string): Record<string, unknown> | undefined {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : undefined;
}

/** The differences between two reports, as `path: before -> after` lines. */
export function compareReports(before: unknown, after: unknown, path = ""): string[] {
	if (JSON.stringify(before) === JSON.stringify(after)) return [];
	const objects =
		before !== null &&
		after !== null &&
		typeof before === "object" &&
		typeof after === "object" &&
		!Array.isArray(before) &&
		!Array.isArray(after);
	if (!objects) return [`${path || "/"}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`];
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	return keys.flatMap((key) =>
		compareReports(
			(before as Record<string, unknown>)[key],
			(after as Record<string, unknown>)[key],
			`${path}/${key}`,
		),
	);
}

function main(args: readonly string[]): void {
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index === -1 ? undefined : args[index + 1];
	};
	const dataDir = option("--data") ?? process.env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2");
	const report = dataReport(dataDir);
	const compare = option("--compare");
	if (compare === undefined) {
		console.log(JSON.stringify(report, null, "\t"));
		return;
	}
	const differences = compareReports(JSON.parse(readFileSync(compare, "utf8")), report);
	for (const line of differences) console.log(line);
	console.log(differences.length ? `${differences.length} differences` : "no differences");
	if (differences.length) process.exitCode = 1;
}

if (import.meta.main) main(process.argv.slice(2));
