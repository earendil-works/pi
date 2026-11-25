// Grantable members and flags (slice 15 §1): one shape for every caller. A remote contract marks the members only
// some callers may have `grantable(...)` (state, events and methods alike) and declares rights that are no member as
// `flags`. The type's admission reads who the caller is and allows with `granted`, the names it gets; the factory
// returns every member, its grantable state and events as builders Chord calls only if granted, and nothing of a
// member nobody was granted is built or sent. A reference has the plain members always, the grantable ones while
// granted, and `granted`. When the caller's role changes, its object is rebuilt and the same reference rebinds.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/77-grantable.ts
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import {
	arr,
	type GrantableName,
	grantable,
	hostKind,
	int,
	local,
	map,
	method,
	obj,
	oneOf,
	remote,
	str,
} from "../../src/contracts/index.ts";
import { allow, createHost, defineFacet, deny } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";

const context = BACKGROUND_CONTEXT;

type Principal = { kind: "person"; id: string } | { kind: "server" };

const Server = hostKind("server");

const Shape = obj({ id: str(), kind: oneOf("stroke", "rect", "text") });
const Change = obj({ seq: int(), what: oneOf("added", "cleared"), by: str() });

// 1. One shape for everyone: `shapes` and `report` for every admitted caller; drawers may add and clear, moderators also
//    see the history and hear reports as they come in. `export` is a right that is no call on the object.
const Canvas = remote("example.canvas", {
	version: 1,
	params: { canvas: str() },
	hostAddress: () => Server(),
	state: { shapes: arr(Shape), history: grantable(arr(Change)) },
	events: { reported: grantable(obj({ shape: str(), by: str() })) },
	methods: {
		report: method(obj({ shape: str() })),
		add: grantable(method(Shape)),
		clear: grantable(method()),
	},
	flags: { export: "Export as image" },
});

// What each role gets: names of the contract's grantable members and flags (a typo does not compile).
type Role = "viewer" | "drawer" | "moderator";
const GRANTS = {
	viewer: [],
	drawer: ["add", "clear", "export"],
	moderator: ["add", "clear", "export", "history", "reported"],
} satisfies Record<Role, GrantableName<typeof Canvas>[]>;

// The roles, on the server: who has which role on which canvas (a store an admission reads).
const Roles = local("example.canvas-roles", {
	version: 1,
	params: {},
	members: { roles: map(str()), set: method(obj({ person: str(), role: str() })) },
});

// The board's data, once on the server, behind every caller's object.
const Board = local("example.canvas-board", {
	version: 1,
	params: {},
	members: {
		shapes: arr(Shape),
		history: arr(Change),
		add: method(obj({ shape: Shape, by: str() })),
		clear: method(str()),
	},
});

let historyBuilt = 0;

const facet = defineFacet<Principal>((host) => {
	host.serve(Roles, (_params, self) => {
		const roles = self.writable<Record<string, string>>({ ada: "drawer" });
		return {
			roles: self.derive([roles], ([value]) => value),
			set: async ({ person, role }) => {
				roles.set({ ...roles.value, [person]: role });
				return null;
			},
		};
	});
	host.serve(Board, (_params, self) => {
		const shapes = self.writable<{ id: string; kind: "stroke" | "rect" | "text" }[]>([]);
		const changes = self.writable<{ seq: number; what: "added" | "cleared"; by: string }[]>([]);
		const record = (what: "added" | "cleared", by: string) =>
			changes.set([...changes.value, { seq: changes.value.length + 1, what, by }]);
		return {
			shapes: self.derive([shapes], ([value]) => value),
			history: self.derive([changes], ([value]) => value),
			add: async ({ shape, by }) => {
				shapes.set([...shapes.value, shape]);
				record("added", by);
				return null;
			},
			clear: async (by) => {
				shapes.set([]);
				record("cleared", by);
				return null;
			},
		};
	});
	host.serve(
		Canvas,
		({ canvas }, principal, { granted }, self) => {
			const by = principal.kind === "person" ? principal.id : "server";
			console.log(`   (the factory runs for ${by} on ${canvas}, granted [${[...granted]}])`);
			const board = self.get(Board, {});
			const reported = self.events<{ shape: string; by: string }>();
			return {
				shapes: board.shapes,
				// A builder: called only for a caller granted `history`.
				history: () => {
					historyBuilt++;
					return board.history;
				},
				reported: () => reported,
				report: async ({ shape }) => {
					reported.emit({ shape, by });
					return null;
				},
				add: async (shape, ctx) => board.add({ shape, by }, ctx),
				clear: async (ctx) => board.clear(by, ctx),
			};
		},
		{
			// 2. The admission: the caller's role, live. Another role rebuilds the caller's object; none denies it.
			admit: (_params, principal, self) =>
				self.derive([self.get(Roles, {}).roles], ([roles]) => {
					if (principal.kind === "server") return allow({ granted: GRANTS.moderator });
					const role = roles[principal.id];
					if (role === undefined || !Object.hasOwn(GRANTS, role)) return deny("not on this canvas");
					return allow({ granted: GRANTS[role as Role] });
				}),
		},
	);
});

const server = createHost<Principal>({ address: Server(), principal: { kind: "server" }, onError: console.error });
await server.load([{ name: "@example/canvas", facet }], context);

// Ada's page: a client whose link the server stamps with her identity.
const page = createHost<Principal>({ onError: console.error });
await page.load([], context);
const [a, b] = memoryLinkPair();
server.accept(a, { principal: { kind: "person", id: "ada" } }, context);
page.connect(b, { principal: { kind: "server" } }, context);
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

// 3. Ada is a drawer: she has `add` and `clear` and the flag `export`, not `history` nor `reported`. Their builder was
//    never called for her, and nothing of them crossed the link.
const canvas = await page.get(Canvas, { canvas: "sketch" }, context);
await canvas.add?.({ id: "s1", kind: "stroke" }, context);
await settled();
console.log("3. ada granted:", [...canvas.granted], "| shapes:", canvas.shapes.value.length);
console.log("   history:", canvas.history, "| reported:", canvas.reported, "| builds of history:", historyBuilt);
console.log("   may export:", canvas.granted.has("export"));

// 4. Code asks for the right it needs: TypeScript makes it check a grantable member before it calls it.
if (canvas.clear !== undefined) console.log("   ada may clear");

// 5. Ada becomes a moderator: her object is rebuilt with `history` and `reported`, the same reference rebinds.
const roles = await server.get(Roles, {}, context);
await roles.set({ person: "ada", role: "moderator" }, context);
await settled();
console.log("5. ada granted:", [...canvas.granted], "| history:", JSON.stringify(canvas.history?.value));
const heard: string[] = [];
await canvas.reported?.on(({ value }) => void heard.push(`${value.by} reported ${value.shape}`), context);
await canvas.report({ shape: "s1" }, context);
await settled();
console.log("   reports:", heard);

// 6. A viewer: the plain members only; a call taken while she could add is refused `forbidden` by the server.
const add = canvas.add!;
await roles.set({ person: "ada", role: "viewer" }, context);
await settled();
console.log("6. ada granted:", [...canvas.granted], "| add:", canvas.add, "| shapes:", canvas.shapes.value.length);
console.log(
	"   a stale add:",
	await add({ id: "s2", kind: "rect" }, context).catch((error: { code: string; message: string }) => error.message),
);

// 7. No role: denied; the reference keeps no value and nothing granted.
await roles.set({ person: "ada", role: "none" }, context);
await settled();
console.log("7. no role:", canvas.state.value.kind, "| granted:", [...canvas.granted]);

await page.close(context);
await server.close(context);
