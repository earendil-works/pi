// Admission (slice 14 §2): a factory is synchronous, so it cannot read data about its caller before it builds the
// caller's object. A remote type's `admit` does: it runs first in every attempt, declares what it reads (references,
// registries, derives, live queries) and returns a watchable of `allow(value)` or `deny(reason)`. The factory is
// handed the value, whose `granted` names the grantable members the caller gets (slice 15). The attempt follows the decision: an equal value
// changes nothing, another one rebuilds the object, a denial seals it (`failed { denied }`, running calls rejected
// `forbidden/revoked`, no value kept). A route asks the same way before it starts anything: no worker starts for a
// person who will be denied. The principal is identity only; what a person may do is data.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/69-admission.ts
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, withTelemetry } from "../../src/context/index.ts";
import {
	grantable,
	hostKind,
	int,
	local,
	method,
	obj,
	oneOf,
	queries,
	remote,
	str,
} from "../../src/contracts/index.ts";
import type { ChordError } from "../../src/data/index.ts";
import { allow, createHost, defineFacet, deny } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { constant } from "../../src/state/index.ts";
import { and, defineTable, eq, openStore, query, sqliteBackend } from "../../src/store/index.ts";

type Principal = { kind: "person"; id: string } | { kind: "server" } | { kind: "worker"; session: string };

const Server = hostKind("server");
const Session = hostKind("session", { id: str() });

// The server's store: the sessions, and who may do what in each (a share row per person and session).
const SessionRow = obj({ id: str(), title: str(), lastTouch: int() });
const ShareRow = obj({ person: str(), session: str(), mode: str() });
const Sessions = local("example.sessions", {
	version: 1,
	params: {},
	members: {
		sessions: queries(SessionRow, { one: obj({ id: str() }) }),
		shares: queries(ShareRow, { one: obj({ person: str(), session: str() }) }),
		create: method(obj({ id: str(), title: str() })),
		touch: method(str()),
		share: method(obj({ person: str(), session: str(), mode: str() })),
		unshare: method(obj({ person: str(), session: str() })),
	},
});
const SessionRows = defineTable("example.session-rows", {
	version: 1,
	columns: { id: str(), title: str(), lastTouch: int({ default: 0 }) },
	key: ["id"],
});
const ShareRows = defineTable("example.share-rows", {
	version: 1,
	columns: { person: str(), session: str(), mode: str() },
	key: ["person", "session"],
});

// One answer per person and session, computed once on the server: every admission of a session asks this object.
const Answer = local("example.answer", {
	version: 1,
	params: { session: str(), person: str() },
	members: { mode: oneOf("none", "read", "write") },
});

// The admitted type: its contract declares the value its factory is handed about a caller.
const Transcript = remote("example.transcript", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	admission: obj({ mode: oneOf("read", "write") }),
	state: { title: str() },
	methods: { say: grantable(method(str(), str())) },
});

// A type on the session's worker: the route decides who reaches a worker at all.
const Scratch = remote("example.scratch", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	state: { text: str() },
});

let sayGate: Promise<void> = Promise.resolve();

const sessionsFacet = defineFacet<Principal>((h) => {
	h.serve(Sessions, (_, self) => {
		const sessions = self.table(SessionRows);
		const shares = self.table(ShareRows);
		return {
			// Each query runs on its table's key.
			sessions: self.queries(
				sessions,
				{ map: (row) => row, reads: ["id", "title", "lastTouch"] },
				{ one: ({ id }: { id: string }) => query(SessionRows).where((s) => eq(s.id, id)) },
			),
			shares: self.queries(
				shares,
				{ map: (row) => row, reads: ["person", "session", "mode"] },
				{
					one: ({ person, session }: { person: string; session: string }) =>
						query(ShareRows).where((x) => and(eq(x.person, person), eq(x.session, session))),
				},
			),
			create: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(sessions, row), ctx);
				return null;
			},
			// A touch is an `update` of the column it changes: readers of other columns are not run.
			touch: async (id, ctx) => {
				await self.tx(async (tx) => tx.update(sessions, { id }, { lastTouch: Date.now() }), ctx);
				return null;
			},
			share: async (row, ctx) => {
				await self.tx(async (tx) => tx.put(shares, row), ctx);
				return null;
			},
			unshare: async (key, ctx) => {
				await self.tx(async (tx) => tx.delete(shares, key), ctx);
				return null;
			},
		};
	});
	h.serve(Answer, ({ session, person }, self) => {
		const store = self.get(Sessions, {});
		const found = self.liveQuery(store.sessions.one, { id: session }, { first: 1 });
		const share = self.liveQuery(store.shares.one, { person, session }, { first: 1 });
		const mode = self.derive([found, share], ([s, x]) => {
			const granted = x.rows[0]?.mode;
			return s.rows.length === 1 && (granted === "read" || granted === "write") ? granted : "none";
		});
		return { mode };
	});
	// `admit` runs before the factory. It declares only what it reads; the factory gets the allowed value.
	h.serve(
		Transcript,
		({ session }, _principal, admitted, _self) => {
			console.log(`   (factory runs for ${session} as ${admitted.mode})`);
			const title = constant(`transcript of ${session}`);
			const say = async (text: string) => {
				await sayGate;
				return `said: ${text}`;
			};
			return { title, say };
		},
		{
			admit: ({ session }, principal, self) => {
				if (principal.kind !== "person") return constant(deny("people only"));
				const answer = self.get(Answer, { session, person: principal.id });
				return self.derive([answer.mode], ([mode]) => {
					if (mode === "none") return deny("no access");
					return mode === "write" ? allow({ mode, granted: ["say"] }) : allow({ mode });
				});
			},
		},
	);
});

const telemetry = new InMemoryTelemetryContext();
const context = withTelemetry(await telemetry.startSpan({ name: "example" }, (span) => span), BACKGROUND_CONTEXT);
const counter = (name: string): number =>
	telemetry
		.getMetrics()
		.filter((metric) => metric.name === name)
		.reduce((sum, metric) => sum + metric.value, 0);
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const started: string[] = [];
const server = createHost<Principal>({
	address: Server(),
	principal: { kind: "server" },
	store,
	telemetry,
	onError: (error) => console.error(error),
});
// The route asks before anything starts: one decision per person and session with holds, shared by them. It reads
// a contract the app's API owns (`Answer`): a route is base code and never reloads. Its `resolve` returns the link
// to the worker itself (the final provider), which the fence after a denial relies on.
server.route(
	Session,
	{
		authorize: () => true,
		admit: (principal, address, self) => {
			if (principal.kind !== "person") return constant(allow(null));
			const answer = self.get(Answer, { session: address.params.id, person: principal.id });
			return self.derive([answer.mode], ([mode]) => (mode === "none" ? deny("no access") : allow(null)));
		},
		resolve: async (address) => {
			started.push(address.key);
			const [up, down] = memoryLinkPair();
			const principal = { kind: "worker", session: address.params.id } as const;
			const worker = createHost<Principal>({ address, principal, onError: (error) => console.error(error) });
			worker.connect(up, { principal: { kind: "server" } }, context);
			const facet = defineFacet<Principal>((w) => w.serve(Scratch, () => ({ text: constant("a scratch pad") })));
			void worker.load([{ name: "@example/scratch", facet }], context);
			return { link: down, principal };
		},
	},
	context,
);
await server.load([{ name: "@example/sessions", facet: sessionsFacet }], context);

// Max's page: a client whose link the server stamps with his identity.
const page = createHost<Principal>({ onError: (error) => console.error(error) });
await page.load([], context);
const [a, b] = memoryLinkPair();
server.accept(a, { principal: { kind: "person", id: "max" } }, context);
page.connect(b, { principal: { kind: "server" } }, context);

const sessions = await server.get(Sessions, {}, context);
await sessions.create({ id: "s1", title: "Holiday" }, context);
await sessions.create({ id: "s2", title: "Budget" }, context);
await sessions.create({ id: "s3", title: "Garden" }, context);
const shown = (ref: {
	readonly state: { readonly value: { readonly kind: string } };
	readonly granted?: ReadonlySet<string>;
}) => {
	const state = ref.state.value as { kind: string; cause?: { kind: string; error: ChordError } };
	return state.kind === "failed"
		? `${state.cause!.kind} (${state.cause!.error.message})`
		: `${state.kind}, granted [${[...(ref.granted ?? [])]}]`;
};

// 1. Max holds the transcript of a session he has no share of: denied, and nothing was built for him.
const transcript = page.hold(Transcript, { session: "s1" }, context);
await settled();
console.log("1. no share:", shown(transcript));

// 2. A share row is written. The answer changes, the decision with it, and the factory runs with the value.
await sessions.share({ person: "max", session: "s1", mode: "read" }, context);
await settled();
console.log("2. shared to read:", shown(transcript));

// 3. Another value rebuilds the object, now granted `say`; an equal one changes nothing.
await sessions.share({ person: "max", session: "s1", mode: "write" }, context);
await settled();
console.log("3. changed to write:", shown(transcript));
await sessions.share({ person: "tanja", session: "s1", mode: "write" }, context);
await settled();
console.log("   another person's share: no factory run above this line");

// 4. The route: no worker starts for a person without access; with a share it starts.
const forbidden = page.hold(Scratch, { session: "s2" }, context);
const scratch = page.hold(Scratch, { session: "s1" }, context);
await settled();
console.log("4. scratch of s2:", shown(forbidden), "| scratch of s1:", shown(scratch), "| workers started:", started);

// 5. What following a session costs (each answer reads `sessions.one` of its session live): a touch of another
//    session runs and probes nothing (an `update` of a column that cannot bring the row into a read that does not
//    show it), a touch of its own runs its one read.
const cost = async (what: string, write: () => Promise<unknown>): Promise<void> => {
	const before = ["chord.query.runs", "chord.query.probes"].map(counter);
	await write();
	const [runs, probes] = ["chord.query.runs", "chord.query.probes"].map((name, i) => counter(name) - before[i]!);
	console.log(`   ${what}: ${runs} runs, ${probes} probes`);
};
console.log("5. reads open: each answer's session and share (Max in s1 and s2)");
await cost("a touch of another session", () => sessions.touch("s3", context));
await cost("a touch of its own session", () => sessions.touch("s1", context));

// 6. Access is withdrawn under a running call: the call is rejected `forbidden/revoked`, the object shows the
//    denial and keeps no value, and the route releases Max's hold at the worker.
const gate = Promise.withResolvers<void>();
sayGate = gate.promise;
const said = transcript.say?.("hello", context) ?? Promise.resolve("");
const outcome = said.then(
	(value) => value,
	(error: ChordError) => `${error.code}/${error.reason}: ${error.message}`,
);
await settled();
await sessions.unshare({ person: "max", session: "s1" }, context);
console.log("6. unshared, the running call:", await outcome);
await settled();
console.log("   transcript:", shown(transcript), "| scratch:", shown(scratch));
let read: string;
try {
	read = transcript.title.value;
} catch (error) {
	read = `throws ${(error as ChordError).code}`;
}
console.log("   a read of its title:", read);
gate.resolve();

// 7. Shared again: both come back, the scratch on the worker that is still running.
await sessions.share({ person: "max", session: "s1", mode: "read" }, context);
await settled();
console.log("7. shared again:", shown(transcript), "|", shown(scratch), "| workers started:", started);

await page.close(context);
await server.close(context);
await store.close(context);
