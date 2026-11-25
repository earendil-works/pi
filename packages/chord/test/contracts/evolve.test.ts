import { describe, expect, expectTypeOf, it } from "vitest";
import type { Context } from "../../src/context/index.ts";
import { type Contract, contractData, type ShapeOf } from "../../src/contracts/contract.ts";
import type { CurrentStep } from "../../src/contracts/history.ts";
import {
	arr,
	bool,
	bytes,
	type EventMember,
	event,
	evolve,
	type GrantableName,
	grantable,
	hostKind,
	type Implementation,
	int,
	keyed,
	local,
	method,
	nul,
	obj,
	remote,
	type Static,
	str,
} from "../../src/contracts/index.ts";
import type { Ungranted } from "../../src/contracts/internal.ts";

const Server = hostKind("server");

const Note = obj({ text: str() });

const NotesV1 = remote("notes", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	state: { notes: arr(Note), count: grantable(int()) },
	methods: { add: method(Note, str()), clear: grantable(method()) },
});

const InfoV1 = local("info", { version: 1, params: {}, members: { title: str(), clear: method() } });

/** The current members of a contract, as Chord holds them. */
function current(contract: Contract) {
	const data = contractData(contract);
	const { members, grantable } = data.versions.at(-1)!;
	return { state: [...members.state.keys()], methods: [...members.methods.keys()], grantable, data };
}

/** The current version of a contract's type-level history. */
type VersionOf<C extends Contract> = CurrentStep<ShapeOf<C>["history"]>["version"];

/** The members of a remote implementation. */
type Members<C extends Contract> = Implementation<C>;

describe("edits", () => {
	it("state changes one state member, and keeps whether it is grantable", () => {
		const v2 = evolve(NotesV1, (e) => e.state("count", str()));
		expect(v2.version).toBe(2);
		expectTypeOf<ReturnType<Members<typeof v2>["count"]>["value"]>().toEqualTypeOf<string>();
		expectTypeOf<Members<typeof v2>["notes"]["value"]>().toEqualTypeOf<{ text: string }[]>();
		expect(current(v2).grantable.has("count")).toBe(true);
		// @ts-expect-error: `missing` is not a state member
		expect(() => evolve(NotesV1, (e) => e.state("missing", str()))).toThrow(
			"notes v2.state.missing: no such state member",
		);
	});

	it("addState adds a state member, a grantable one when marked", () => {
		const v2 = evolve(NotesV1, (e) => e.addState("total", int()).addState("hidden", grantable(int())));
		expect(current(v2).state).toEqual(["notes", "count", "total", "hidden"]);
		expect([...current(v2).grantable].sort()).toEqual(["clear", "count", "hidden"]);
		expectTypeOf<Members<typeof v2>["total"]["value"]>().toEqualTypeOf<number>();
		expect(() => evolve(NotesV1, (e) => e.addState("notes", int()))).toThrow(
			"notes v2.state.notes: already declared",
		);
	});

	it("removeState removes a state member", () => {
		const v2 = evolve(NotesV1, (e) => e.removeState("count"));
		expect(current(v2).state).toEqual(["notes"]);
		expect(current(v2).grantable.has("count")).toBe(false);
		expectTypeOf<keyof Members<typeof v2>>().toEqualTypeOf<"notes" | "add" | "clear">();
	});

	it("args and result change one side of a method", () => {
		const v2 = evolve(NotesV1, (e) => e.args("add", obj({ text: str(), tag: str() })).result("add", int()));
		expect(current(v2).data.versions[1]!.changes).toEqual([
			["add", "args"],
			["add", "result"],
		]);
		type Add = Members<typeof v2>["add"];
		expectTypeOf<Parameters<Add>[0]>().toEqualTypeOf<{ text: string; tag: string }>();
		expectTypeOf<Awaited<ReturnType<Add>>>().toEqualTypeOf<number>();
	});

	it("method replaces both sides", () => {
		const v2 = evolve(NotesV1, (e) => e.method("clear", obj({ all: bool() }), bool()));
		type Clear = Members<typeof v2>["clear"];
		expectTypeOf<Parameters<Clear>[0]>().toEqualTypeOf<{ all: boolean }>();
		expectTypeOf<Awaited<ReturnType<Clear>>>().toEqualTypeOf<boolean>();
		expect(current(v2).grantable.has("clear")).toBe(true);
		// @ts-expect-error: no method `missing`
		expect(() => evolve(NotesV1, (e) => e.method("missing", nul(), nul()))).toThrow('notes v2: no method "missing"');
	});

	it("addMethod adds a method, a grantable one with grantable(method(...))", () => {
		const v2 = evolve(NotesV1, (e) => e.addMethod("reset", nul(), nul()).addMethod("lock", grantable(method(str()))));
		expect(current(v2).methods).toEqual(["add", "clear", "reset", "lock"]);
		expect(current(v2).grantable.has("lock")).toBe(true);
		expectTypeOf<Parameters<Members<typeof v2>["lock"]>[0]>().toEqualTypeOf<string>();
		expect(() => evolve(NotesV1, (e) => e.addMethod("add", nul(), nul()))).toThrow(
			"notes v2.methods.add: already declared",
		);
		expect(() =>
			evolve(InfoV1, (e) =>
				(e as never as { addMethod: (...args: unknown[]) => typeof e }).addMethod("m", grantable(method())),
			),
		).toThrow("info v2.members.m: only a remote contract has grantable members");
	});

	it("removeMethod removes a method", () => {
		const v2 = evolve(NotesV1, (e) => e.removeMethod("add"));
		expect(current(v2).methods).toEqual(["clear"]);
		expectTypeOf<keyof Members<typeof v2>>().toEqualTypeOf<"notes" | "count" | "clear">();
	});

	it("local edits are the same", () => {
		const v2 = evolve(InfoV1, (e) =>
			e
				.state("title", int())
				.addState("body", str())
				.addMethod("save", obj({ force: bool() }), nul())
				.removeMethod("clear"),
		);
		expect(current(v2)).toMatchObject({ state: ["title", "body"], methods: ["save"] });
		expectTypeOf<keyof Implementation<typeof v2>>().toEqualTypeOf<"title" | "body" | "save">();
		const v3 = evolve(v2, (e) => e.removeState("body").args("save", nul()));
		// Arguments changed to `null`: the method omits them now.
		expectTypeOf<Parameters<Implementation<typeof v3>["save"]>>().toEqualTypeOf<[context: Context]>();
	});

	it("checks every edit: closed arguments and the vocabulary", () => {
		expect(() => evolve(NotesV1, (e) => e.args("add", { type: "object", properties: { text: str() } }))).toThrow(
			"notes v2.methods.add.args: argument objects must be closed",
		);
		expect(() => evolve(InfoV1, (e) => e.addMethod("m", { type: "object", properties: {} }, nul()))).toThrow(
			"info v2.members.m.args: argument objects must be closed",
		);
		expect(() => evolve(NotesV1, (e) => e.state("count", { not: {} } as never))).toThrow(
			'notes v2.state.count: unsupported keyword "not"',
		);
		expect(() => evolve(NotesV1, (e) => e.state("count", { type: "object", properties: {} }))).not.toThrow();
	});
});

describe("keyed edits (slice 7b)", () => {
	const Store = local("store", { version: 1, params: {}, members: { notes: keyed(Note), n: int() } });

	it("changes, adds and removes a local contract's keyed members, each version fingerprinted", () => {
		const V2 = evolve(Store, (e) => e.keyed("notes", obj({ text: str(), tag: str() })).addKeyed("drafts", Note));
		const V3 = evolve(V2, (e) => e.removeKeyed("drafts"));
		const versions = contractData(V3).versions;
		expect(versions.map(({ members }) => [...members.keyed.keys()])).toEqual([
			["notes"],
			["notes", "drafts"],
			["notes"],
		]);
		expect(versions[1]!.changes).toEqual([
			["notes", "keyed"],
			["drafts", "keyed"],
		]);
		expect(new Set(versions.map(({ fingerprint }) => fingerprint)).size).toBe(3);
		// The same edits elsewhere give the same fingerprint (an old plugin's copy).
		const again = evolve(Store, (e) => e.keyed("notes", obj({ text: str(), tag: str() })).addKeyed("drafts", Note));
		expect(contractData(again).versions[1]!.fingerprint).toBe(versions[1]!.fingerprint);
	});

	it("refuses an unknown keyed member, one declared already, and a kind change", () => {
		expect(() => evolve(Store, (e) => e.keyed("missing" as "notes", Note))).toThrow("no such keyed member");
		expect(() => evolve(Store, (e) => e.addKeyed("n", Note))).toThrow("already declared");
		expect(() => evolve(Store, (e) => e.removeKeyed("missing" as "notes"))).toThrow("no such keyed member");
	});
});

describe("kinds and fixed parts", () => {
	it("a member's kind never changes, also not after a removal and re-add", () => {
		expect(() => evolve(NotesV1, (e) => e.removeState("count").addMethod("count", nul(), nul()))).toThrow(
			'notes v2.methods.count: "count" is a state member; its kind never changes',
		);
		const v2 = evolve(NotesV1, (e) => e.removeMethod("clear"));
		const v3 = evolve(v2, (e) => e.state("count", str()));
		expect(() => evolve(v3, (e) => e.addState("clear", str()))).toThrow(
			'notes v4.state.clear: "clear" is a method member; its kind never changes',
		);
	});

	it("the flags never change, and a flag's name is never a new member's", () => {
		const Flagged = remote("doc", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			flags: { export: "Export" },
		});
		const V2 = evolve(Flagged, (e) => e.addState("n", int()));
		expect([...contractData(V2).flags.keys()]).toEqual(["export"]);
		expectTypeOf<GrantableName<typeof V2>>().toEqualTypeOf<"export">();
		expect(() => evolve(Flagged, (e) => e.addState("export", int()))).toThrow(
			"doc v2.state.export: already declared",
		);
	});

	it("a new base is a full declaration with an explicit version and no older versions", () => {
		const base = remote("notes", {
			version: 5,
			params: { session: str(), tenant: str() },
			hostAddress: () => Server(),
		});
		expect(contractData(base).versions.map(({ version }) => version)).toEqual([5]);
		expect(evolve(base, (e) => e).version).toBe(6);
	});

	it("evolve must return the editor it was given", () => {
		const other = evolve(NotesV1, (e) => e);
		expect(other.version).toBe(2);
		let foreign: unknown;
		evolve(InfoV1, (e) => {
			foreign = e;
			return e;
		});
		expect(() => evolve(NotesV1, () => foreign as never)).toThrow(
			"notes v2: evolve must return the editor it was given",
		);
	});

	it("leaves the previous contract untouched", () => {
		evolve(NotesV1, (e) => e.removeState("count").removeMethod("add"));
		expect(current(NotesV1)).toMatchObject({ state: ["notes", "count"], methods: ["add", "clear"] });
	});
});

describe("long histories", () => {
	it("count versions beyond 9 and 99, at runtime and in the types", () => {
		let contract: Contract = InfoV1;
		for (let step = 0; step < 120; step++) contract = evolve(contract, (e) => e);
		expect(contract.version).toBe(121);
		expect(contractData(contract).versions).toHaveLength(121);

		const v9 = local("i", { version: 9, params: {}, members: { s: str() } });
		const v10 = evolve(v9, (e) => e);
		const v99 = local("i", { version: 99, params: {}, members: { s: str() } });
		const v100 = evolve(v99, (e) => e);
		const v101 = evolve(v100, (e) => e.state("s", int()));
		expectTypeOf<VersionOf<typeof v10>>().toEqualTypeOf<"10">();
		expectTypeOf<VersionOf<typeof v100>>().toEqualTypeOf<"100">();
		expectTypeOf<VersionOf<typeof v101>>().toEqualTypeOf<"101">();
	});

	it("the types track every step with its changes", () => {
		const v2 = evolve(NotesV1, (e) => e.state("count", str()).addMethod("reset", nul(), nul()));
		type History = ShapeOf<typeof v2>["history"];
		expectTypeOf<History["length"]>().toEqualTypeOf<2>();
		expectTypeOf<History[1]["changes"]>().toEqualTypeOf<["count", "state"] | ["reset", "args" | "result"]>();
		expectTypeOf<Static<Ungranted<History[0]["members"]["state"]["count"]>>>().toEqualTypeOf<number>();
	});
});

describe('event edits (decision "Events: fire-and-forget members")', () => {
	const Sample = obj({ y: int() });
	const Match = remote("match", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		state: { score: int() },
		events: { paddle: grantable(Sample) },
	});

	it("change, add and remove an event member, each a change of its own kind, typed", () => {
		const V2 = evolve(Match, (e) => e.event("paddle", obj({ y: int(), t: int() })).addEvent("ball", Sample));
		const V3 = evolve(V2, (e) => e.removeEvent("paddle"));
		const versions = contractData(V3).versions;
		expect(versions.map(({ members }) => [...members.events.keys()])).toEqual([
			["paddle"],
			["paddle", "ball"],
			["ball"],
		]);
		expect(versions[1]!.changes).toEqual([
			["paddle", "event"],
			["ball", "event"],
		]);
		expect(new Set(versions.map(({ fingerprint }) => fingerprint)).size).toBe(3);
		expectTypeOf<Members<typeof V2>["paddle"]>().toEqualTypeOf<() => EventMember<{ y: number; t: number }>>();
		expectTypeOf<Members<typeof V2>["ball"]>().toEqualTypeOf<EventMember<{ y: number }>>();
	});

	it("are the same in a local contract", () => {
		const Store = local("store", { version: 1, params: {}, members: { paddle: event(Sample) } });
		const V2 = evolve(Store, (e) => e.event("paddle", obj({ y: int(), t: int() })).addEvent("ball", Sample));
		const V3 = evolve(V2, (e) => e.removeEvent("ball"));
		expect(contractData(V3).versions.map(({ members }) => [...members.events.keys()])).toEqual([
			["paddle"],
			["paddle", "ball"],
			["paddle"],
		]);
	});

	it("refuse an unknown event member, one declared already, and bytes", () => {
		expect(() => evolve(Match, (e) => e.event("missing" as "paddle", Sample))).toThrow("no such event member");
		expect(() => evolve(Match, (e) => e.addEvent("score", Sample))).toThrow("already declared");
		expect(() => evolve(Match, (e) => e.removeEvent("missing" as "paddle"))).toThrow("no such event member");
		expect(() => evolve(Match, (e) => e.addEvent("frame", obj({ data: bytes() })))).toThrow(
			"an event's values are JSON only",
		);
	});
});
