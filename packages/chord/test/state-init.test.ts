import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { type Ctx, createHost, type Facet, isChordError, local, method } from "../src/index.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !check(); attempt++) await tick();
	assert.ok(check(), "condition not reached");
}

function latch<T>() {
	let open: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

const Notes = local("t.notes", {
	version: 1,
	input: Type.Object({}),
	members: {
		notes: Type.Array(Type.String()),
		count: Type.Number(),
		has: method(Type.String(), Type.Boolean()),
		add: method(Type.String()),
	},
});

const NotesSchema = Type.Array(Type.String());

describe("state init", () => {
	it("runs after the resources are open and before the object goes live: nothing sees another value", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const loaded = latch<string[]>();
		const log: string[] = [];
		host.serve(Notes, (_input, _principal, self) => {
			const db = self.resource("db", {
				version: 1,
				open: () => {
					log.push("open");
					return { load: () => loaded.promise };
				},
			});
			const notes = self.state("notes", NotesSchema, {
				init: async () => {
					log.push("init");
					return await db.value.load();
				},
			});
			const count = self.derive([notes], (list) => list.length);
			self.on("notes", notes, (list) => {
				log.push(`listener ${list.join(",")}`);
			});
			self.task(async () => {
				log.push(`task ${notes.value.join(",")}`);
			});
			return {
				notes,
				count,
				has: (note) => notes.value.includes(note),
				add: (note, ctx) => {
					notes.change(ctx, (draft) => {
						draft.push(note);
					});
				},
			};
		});
		const ref = host.hold(Notes, {});
		const seen: unknown[] = [];
		ref.notes.subscribe((value) => seen.push(value));
		// A call made while init runs waits until the object is live, then reads the loaded value.
		const has = host.root((ctx) => ref.has("a", ctx));
		await until(() => log.includes("init"));
		assert.equal(ref.status, "loading");
		loaded.open(["a", "b"]);
		assert.equal(await has, true);
		assert.equal(ref.count.value, 2);
		await until(() => log.length === 4);
		assert.deepEqual(log, ["open", "init", "listener a,b", "task a,b"]);
		// Before live, a reference's member has no value (undefined); its first value is the loaded one.
		assert.deepEqual(
			seen.filter((value) => value !== undefined),
			[["a", "b"]],
		);
	});

	it("an init cell cannot be read inside the factory", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		host.serve(Notes, (_input, _principal, self) => {
			const notes = self.state("notes", NotesSchema, { init: () => [] });
			const count = self.derive([notes], (list) => list.length);
			notes.value;
			return { notes, count, has: () => false, add: () => {} };
		});
		await assert.rejects(host.hold(Notes, {}).ready, (error) => isChordError(error) && error.code === "not_ready");
	});

	it("a throwing or invalid init fails the activation and closes its resources; the next get tries again", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		let result: () => unknown = () => {
			throw new Error("db down");
		};
		const closed: string[] = [];
		host.serve(Notes, (_input, _principal, self) => {
			self.resource("db", { version: 1, open: () => "db", close: (db) => void closed.push(db) });
			const notes = self.state("notes", NotesSchema, { init: () => result() as string[] });
			const count = self.derive([notes], (list) => list.length);
			return { notes, count, has: () => false, add: () => {} };
		});
		await assert.rejects(host.hold(Notes, {}).ready, /db down/);
		assert.deepEqual(closed, ["db"]);
		result = () => [1];
		await assert.rejects(host.hold(Notes, {}).ready, (error) => isChordError(error) && error.code === "invalid");
		assert.deepEqual(closed, ["db", "db"]);
		result = () => ["ok"];
		const ref = host.hold(Notes, {});
		await ref.ready;
		assert.deepEqual(ref.notes.value, ["ok"]);
	});

	it("init runs in a root: it can call other objects", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const Source = local("t.source", {
			version: 1,
			input: Type.Object({}),
			members: { all: method(undefined, NotesSchema) },
		});
		host.serve(Source, () => ({ all: () => ["from source"] }));
		host.serve(Notes, (_input, _principal, self) => {
			const notes = self.state("notes", NotesSchema, {
				init: async (ctx: Ctx) => (await ctx.get(Source, {})).all(ctx),
			});
			const count = self.derive([notes], (list) => list.length);
			return { notes, count, has: () => false, add: () => {} };
		});
		const ref = host.hold(Notes, {});
		await ref.ready;
		assert.deepEqual(ref.notes.value, ["from source"]);
	});

	describe("reload", () => {
		const facet = (spec: {
			readonly inits: string[];
			readonly extra?: () => string[];
			readonly countVersion?: number;
		}): Facet => ({
			name: "notes",
			setup: (api) =>
				api.serve(Notes, (_input, _principal, self) => {
					const notes = self.state("notes", NotesSchema, {
						init: () => {
							spec.inits.push("notes");
							return ["loaded"];
						},
					});
					const counter = self.state("counter", Type.Number(), 0, { version: spec.countVersion ?? 1 });
					const extra = spec.extra;
					const more =
						extra === undefined
							? undefined
							: self.state("more", NotesSchema, {
									init: () => {
										spec.inits.push("more");
										return extra();
									},
								});
					const count = self.derive(more === undefined ? [notes, counter] : [notes, counter, more], (...lists) =>
						lists.reduce<number>((sum, list) => sum + (typeof list === "number" ? list : list.length), 0),
					);
					return {
						notes,
						count,
						has: (note) => notes.value.includes(note),
						add: (note, ctx) => {
							notes.change(ctx, (draft) => {
								draft.push(note);
							});
						},
					};
				}),
		});

		it("keeps an existing cell without running init; a cell the reload adds runs init while it prepares", async () => {
			const host = createHost({ self: { kind: "host" }, onError: () => {} });
			const inits: string[] = [];
			await host.install(facet({ inits }));
			const ref = host.hold(Notes, {});
			await ref.ready;
			await host.root((ctx) => ref.add("written", ctx));
			await host.reload([facet({ inits, extra: () => ["x", "y"] })]);
			assert.deepEqual(inits, ["notes", "more"]);
			assert.deepEqual(ref.notes.value, ["loaded", "written"]);
			// The new derivation counts the kept cell and the added one: 2 + 0 + 2.
			assert.equal(ref.count.value, 4);
		});

		it("a failing init of an added cell refuses the reload; the old code keeps running", async () => {
			const host = createHost({ self: { kind: "host" }, onError: () => {} });
			const inits: string[] = [];
			await host.install(facet({ inits }));
			const ref = host.hold(Notes, {});
			await ref.ready;
			await assert.rejects(
				host.reload([
					facet({
						inits,
						extra: () => {
							throw new Error("cannot load more");
						},
					}),
				]),
				/cannot load more/,
			);
			assert.equal(ref.count.value, 1);
			assert.equal(await host.root((ctx) => ref.has("loaded", ctx)), true);
		});

		it("in a gated reload, an added cell runs init at the gate", async () => {
			const host = createHost({ self: { kind: "host" }, onError: () => {} });
			const inits: string[] = [];
			await host.install(facet({ inits }));
			const ref = host.hold(Notes, {});
			await ref.ready;
			const report = await host.reload([facet({ inits, countVersion: 2, extra: () => ["x"] })]);
			assert.equal(report.gated.length, 1);
			assert.deepEqual(inits, ["notes", "more"]);
			assert.equal(ref.count.value, 2);
		});
	});
});
