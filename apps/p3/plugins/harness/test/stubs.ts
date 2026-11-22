// Stand-ins for the plugin tier of the harness and the transcript on a session's worker: on a stand-in server, its
// `SessionFacts` (a row and things the test changes, and the reports it records) and `SessionAccess` (each caller's
// access, as the test sets it); on the worker, this device's `ExecutionEnvironments` (a folder of the test's). The real tools and faux login plugins'
// worker facets load beside them, imported as modules.

import {
	defineFacet,
	type JsonValue,
	type P3Principal,
	type PluginFacet,
	SessionAccess,
	SessionFacts,
	type SessionRow,
	type SessionState,
	type Writable,
} from "@earendil-works/p3/v1";
import { ExecutionEnvironments, NodeExecutionEnv } from "@earendil-works/p3/v1/worker";
import faux from "../../../test/plugins/faux-login/worker.ts";
import tools from "../../tools/worker.ts";

/** A thing as `SessionFacts` gives it to the worker. */
export type Thing = { thing: string; kind: string; ref: string; version: number; options: JsonValue };

/** What the test drives the stand-ins with. */
export type Server = {
	/** The reports the worker made, in order. */
	readonly reports: SessionState[];
	/** Sets the session's row (as the server's store would change it). */
	row(change: Partial<SessionRow>): void;
	/** Sets the session's things. */
	things(things: readonly Thing[]): void;
	/** Sets the access of callers by key (`owner`, `person:<id>`); unset: `none`. */
	access(caller: string, access: "none" | "read" | "write"): void;
	/** Makes the next reports wait until `release` resolves (a slow server). */
	hold(release: Promise<void>): void;
};

/** A session row of `id` working in `folder`. */
export function sessionRow(id: string, folder: string): SessionRow {
	return {
		id,
		app: "test",
		title: "Test session",
		location: { environment: "this-device", folder },
		createdAt: 1,
		state: "settled",
		lastTouch: 1,
		archivedAt: null,
	};
}

/** The stand-ins (plus the tools and faux login plugins) for session `row.id`, and the server's controls. */
export function standIns(
	row: SessionRow,
	things: readonly Thing[],
): { stubs: PluginFacet<P3Principal>[]; server: PluginFacet<P3Principal>[]; control: Server } {
	let rowValue = row;
	let thingsValue = things;
	let held: Promise<void> = Promise.resolve();
	const rows = new Set<Writable<SessionRow>>();
	const lists = new Set<Writable<readonly Thing[]>>();
	const accesses = new Map<string, "none" | "read" | "write">([["owner", "write"]]);
	const answers = new Set<{ caller: string; access: Writable<string> }>();
	const reports: SessionState[] = [];
	const server: Server = {
		reports,
		row: (change) => {
			rowValue = { ...rowValue, ...change };
			for (const writable of rows) writable.set(rowValue);
		},
		things: (next) => {
			thingsValue = next;
			for (const writable of lists) writable.set(thingsValue);
		},
		access: (caller, access) => {
			accesses.set(caller, access);
			for (const answer of answers) if (answer.caller === caller) answer.access.set(access);
		},
		hold: (release) => {
			held = release;
		},
	};
	const facet = defineFacet((host) => {
		host.serve(SessionFacts, (_params, _principal, self) => {
			const session = self.writable(rowValue);
			const list = self.writable(thingsValue);
			rows.add(session);
			lists.add(list);
			return {
				variant: "worker",
				members: {
					session: self.derive([session], ([value]) => value),
					things: self.derive([list], ([value]) => [...value]),
					report: async ({ state }) => {
						await held;
						reports.push(state);
						server.row({ state });
						return null;
					},
				},
			};
		});
		host.serve(SessionAccess, ({ caller }, _principal, self) => {
			const access = self.writable(accesses.get(caller) ?? "none");
			answers.add({ caller, access });
			return {
				variant: "answer",
				members: { access: self.derive([access], ([value]) => value as "none" | "read" | "write") },
			};
		});
	});
	const device = defineFacet((host, self) => {
		host.serve(ExecutionEnvironments, {
			compose: (table) => (location, context) => table[0]?.value(location, context),
		});
		self.contribute(ExecutionEnvironments, (location) => new NodeExecutionEnv({ cwd: location.folder }));
	});
	return {
		server: [{ name: "test.server", facet }],
		stubs: [
			{ name: "test.device", facet: device },
			{ name: "p3-test-faux-login", facet: faux },
			{ name: "@earendil-works/p3-tools", facet: tools },
		],
		control: server,
	};
}
