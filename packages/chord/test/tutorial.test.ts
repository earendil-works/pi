// example:imports
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { it, onTestFinished } from "vitest";
import {
	type Ctx,
	createHost,
	defineFacet,
	defineRegistry,
	type Facet,
	type FacetApi,
	type Factory,
	forbidden,
	type Host,
	hostNamed,
	invalid,
	isChordError,
	local,
	memoryLinkPair,
	method,
	opaque,
	remote,
	type StateOptions,
} from "../src/index.ts";

// end-example:imports

// Compare every printed example with its runnable source, not a second handwritten copy.
const tutorial = readFileSync(new URL("../docs/tutorial.md", import.meta.url), "utf8");
const source = readFileSync(new URL(import.meta.url), "utf8");
const examples = [...source.matchAll(/^[\t ]*\/\/ example:([\w-]+)\n([\s\S]*?)^[\t ]*\/\/ end-example:\1$/gm)];
const printed = [...tutorial.matchAll(/<!-- example:([\w-]+) -->\n```ts\n([\s\S]*?)\n```/g)];
function normalize(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.trim();
}
function checkExamples(section: string): void {
	assert.equal(printed.length, examples.length, "every tutorial example must have runnable source");
	assert.equal((tutorial.match(/```ts\n/g) ?? []).length, printed.length, "no untracked TypeScript examples");
	for (const match of examples.filter((entry) => entry[1] === "imports" || entry[1]?.startsWith(section))) {
		const copies = printed.filter((entry) => entry[1] === match[1]);
		assert.equal(copies.length, 1, `one printed copy of ${match[1]}`);
		assert.equal(normalize(copies[0]![2]!), normalize(match[2]!), `tutorial drift: ${match[1]}`);
	}
}

// example:02-contract
const TodoLabel = local("tutorial.todos", {
	version: 1,
	input: Type.Object({ list: Type.String() }),
	members: { label: method(undefined, Type.String()) },
});
// end-example:02-contract

// example:03-contract
const Todo = Type.Object({ text: Type.String(), done: Type.Boolean() });
const Rows = Type.Array(Todo);
const TodoStore = local("tutorial.todos", {
	version: 1,
	input: Type.Object({ list: Type.String() }),
	members: {
		label: method(undefined, Type.String()),
		rows: Rows,
		openCount: Type.Number(),
		add: method(Type.Object({ text: Type.String() })),
		finish: method(Type.Object({ index: Type.Integer() })),
		reset: method(Rows),
	},
});
// end-example:03-contract

// example:03-factory
/** The store's factory; `options` versions its rows (section 9). */
const todoStore =
	(options?: StateOptions<Static<typeof Rows>>): Factory<typeof TodoStore> =>
	({ list }, _principal, self) => {
		const rows = self.state("rows", Rows, [], options);
		const openCount = self.derive([rows], (todos) => todos.filter((todo) => !todo.done).length);
		return {
			label: () => `Todos for ${list}`,
			rows,
			openCount,
			add: ({ text }, ctx) => {
				rows.change(ctx, (draft) => {
					draft.push({ text, done: false });
				});
			},
			finish: ({ index }, ctx) => {
				rows.change(ctx, (draft) => {
					const todo = draft[index];
					if (!todo) throw invalid("args", "No such todo");
					todo.done = true;
				});
			},
			reset: (next, ctx) => {
				rows.replace(ctx, next, { diff: true });
			},
		};
	};
const todoFactory = todoStore();
// end-example:03-factory

// example:05-views
const Todos = remote("tutorial.todo-view", {
	version: 1,
	input: Type.Object({ list: Type.String() }),
	host: hostNamed("server"),
	variants: {
		viewer: { state: { rows: Rows } },
		editor: {
			state: { rows: Rows },
			methods: { add: method(Type.Object({ text: Type.String() })) },
		},
	},
});

/** Who may ask: the owner, a guest, or the server's own code. */
type Principal = "owner" | "guest" | "server";

function serveViews(api: Pick<Host<Principal>, "serve">): void {
	api.serve(Todos, ({ list }, principal, self) => {
		if (list !== "family") throw forbidden("This list is not shared");
		const store = self.get(TodoStore, { list });
		if (principal === "guest") {
			return { variant: "viewer", rows: store.rows };
		}
		return {
			variant: "editor",
			rows: store.rows,
			add: ({ text }, ctx) => {
				if (text.trim().length === 0) throw invalid("args", "A todo needs text");
				return store.add({ text }, ctx);
			},
		};
	});
}
// end-example:05-views

it("01: objects live inside hosts", { timeout: 5000 }, async () => {
	checkExamples("01");
	// example:01
	const host = createHost({ self: "server", name: "todo-server" });
	assert.equal(host.name, "todo-server");
	await host.close();
	// end-example:01
});

it("02: first contract, factory, reference and root", { timeout: 5000 }, async () => {
	checkExamples("02");
	onTestFinished(() => host.close());
	// example:02-call
	const host = createHost({ self: "server" });
	host.serve(TodoLabel, ({ list }) => ({ label: () => `Todos for ${list}` }));
	const result = await host.root(async (ctx) => {
		const todos = await ctx.get(TodoLabel, { list: "family" });
		return todos.label(ctx);
	});
	assert.equal(result, "Todos for family");
	// end-example:02-call
});

it("03: cells publish values and derivations", { timeout: 5000 }, async () => {
	checkExamples("03");
	onTestFinished(() => host.close());
	// example:03-call
	const host = createHost({ self: "server", dev: true });
	host.serve(TodoStore, todoFactory);
	const todos = await host.get(TodoStore, { list: "family" });
	const counts: (number | undefined)[] = [];
	const stop = todos.openCount.subscribe((value) => counts.push(value));
	await host.root(async (ctx) => {
		await todos.add({ text: "Buy milk" }, ctx);
		await todos.finish({ index: 0 }, ctx);
		await todos.reset([], ctx);
	});
	assert.deepEqual(counts, [0, 1, 0]);
	assert.deepEqual(todos.rows.value, []);
	stop();
	todos.release();
	// end-example:03-call
});

it("04: holds, asynchronous resources and release", { timeout: 5000 }, async () => {
	checkExamples("04");
	onTestFinished(() => host.close());
	// example:04-database
	const Database = local("tutorial.database", {
		version: 1,
		input: Type.Object({}),
		members: { db: opaque<{ saved: string[] }>("tutorial.database@1") },
	});
	const SavedTodos = local("tutorial.saved-todos", {
		version: 1,
		input: Type.Object({ list: Type.String() }),
		members: { add: method(Type.Object({ text: Type.String() })) },
	});
	const host = createHost({ self: "server" });
	let opens = 0;
	const closed = Promise.withResolvers<void>();
	host.serve(Database, (_input, _principal, self) => {
		const db = self.resource("db", {
			version: 1,
			open: async () => {
				opens++;
				return { saved: [] as string[] };
			},
			close: () => closed.resolve(),
		});
		return { db: self.expose(db) };
	});
	// end-example:04-database
	// example:04-saving
	host.serve(TodoStore, todoFactory);
	host.serve(
		SavedTodos,
		({ list }, _principal, self) => {
			const database = self.get(Database, {});
			const todos = self.get(TodoStore, { list });
			return {
				add: async ({ text }, ctx) => {
					database.db!.saved.push(text);
					await todos.add({ text }, ctx);
				},
			};
		},
		{ linger: 0 },
	);
	// end-example:04-saving
	// example:04-call
	const saved = await host.get(SavedTodos, { list: "family" });
	const database = await host.get(Database, {});
	await host.root((ctx) => saved.add({ text: "Buy milk" }, ctx));
	assert.deepEqual(database.db!.saved, ["Buy milk"]);
	assert.equal(opens, 1);
	const statuses: string[] = [];
	saved.onStatus((status) => statuses.push(status));
	database.release();
	saved.release();
	await closed.promise;
	assert.equal(saved.status, "released");
	assert.ok(statuses.includes("released"));
	// end-example:04-call
});

it("05: principals select views of one shared store", { timeout: 5000 }, async () => {
	checkExamples("05");
	onTestFinished(() => host.close());
	// example:05-call
	const host = createHost<Principal>({ name: "server", self: "server", principalKey: (principal) => principal });
	host.serve(TodoStore, todoFactory);
	serveViews(host);
	const owner = await host.get(Todos, { list: "family" }, { principal: "owner" });
	const guest = await host.get(Todos, { list: "family" }, { principal: "guest" });
	assert.ok(owner.variant === "editor"); // narrows the reference to the editor variant
	assert.equal(guest.variant, "viewer");
	await host.root((ctx) => owner.add({ text: "Buy milk" }, ctx), { principal: "owner" });
	assert.deepEqual(guest.rows.value, [{ text: "Buy milk", done: false }]);
	// @ts-expect-error A viewer has no add: TypeScript refuses it, and so does the provider.
	await assert.rejects(guest.add({ text: "Not allowed" }), (error) => isChordError(error, "not_in_variant"));
	await assert.rejects(owner.add({ text: " " }), (error) => isChordError(error, "invalid"));
	// end-example:05-call
});

it("06: remote methods and live state over a memory link", { timeout: 5000 }, async () => {
	checkExamples("06");
	onTestFinished(() => server.close());
	onTestFinished(() => browser.close());
	// example:06
	const server = createHost<Principal>({ self: "server", name: "server" });
	server.serve(TodoStore, todoFactory);
	serveViews(server);
	const [down, up] = memoryLinkPair();
	server.accept(down, { principal: "owner", kind: "client" });
	const browser = createHost({
		self: "browser",
		name: "browser",
		kind: "client",
		upstream: { link: up, principal: "server" },
	});
	const todos = await browser.get(Todos, { list: "family" });
	assert.ok(todos.variant === "editor");
	assert.deepEqual(todos.rows.value, []);
	const updated = Promise.withResolvers<void>();
	const stop = todos.rows.subscribe((rows) => {
		if (rows.length === 1) updated.resolve();
	});
	await browser.root((ctx) => todos.add({ text: "Buy milk" }, ctx));
	await updated.promise;
	assert.deepEqual(todos.rows.value, [{ text: "Buy milk", done: false }]);
	// Deliberately bypass TypeScript to simulate a malformed caller.
	await assert.rejects(todos.add({ text: 123 } as never), (error) => isChordError(error, "invalid"));
	stop();
	// A held reference keeps its state without listeners.
	assert.deepEqual(todos.rows.value, [{ text: "Buy milk", done: false }]);
	todos.release();
	// end-example:06
});

it("07: listeners react and tasks start fresh calls", { timeout: 5000 }, async () => {
	checkExamples("07");
	onTestFinished(() => host.close());
	// example:07
	const Activity = local("tutorial.activity", {
		version: 1,
		input: Type.Object({}),
		members: { seen: Type.Number() },
	});
	const host = createHost({ self: "server" });
	host.serve(TodoStore, todoFactory);
	const observed = Promise.withResolvers<void>();
	const seeded = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	host.serve(Activity, (_input, _principal, self) => {
		const todos = self.get(TodoStore, { list: "family" });
		const seen = self.state("seen", Type.Number(), 0);
		self.on("rows", todos.rows, (rows, ctx) => {
			seen.replace(ctx, rows?.length ?? 0);
			if (rows?.length === 1) observed.resolve();
		});
		self.task(async (ctx) => {
			await todos.add({ text: "Review the list" }, ctx);
			seeded.resolve();
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) resolve();
				else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			stopped.resolve();
		});
		return { seen };
	});
	const activity = await host.get(Activity, {});
	await Promise.all([seeded.promise, observed.promise]);
	assert.equal(activity.seen.value, 1);
	activity.release();
	await stopped.promise;
	// end-example:07
});

it("08: plugins contribute registry entries and expose callbacks", { timeout: 5000 }, async () => {
	checkExamples("08");
	onTestFinished(() => host.close());
	// example:08
	const Actions = defineRegistry<(ctx: Ctx) => Promise<number>>("tutorial.actions");
	const Menu = local("tutorial.menu", { version: 1, input: Type.Object({}) });
	let click: (() => Promise<number>) | undefined;
	const storeFacet: Facet = {
		name: "todo-store",
		...defineFacet((api) => api.serve(TodoStore, todoFactory)),
	};
	const menuFacet: Facet = {
		name: "todo-menu",
		...defineFacet(
			(api) => {
				api.serve(
					Menu,
					(_input, _principal, self) => {
						const todos = self.get(TodoStore, { list: "family" });
						self.register(Actions, {
							addSample: async (ctx) => {
								await todos.add({ text: "Try plugins" }, ctx);
								return todos.openCount.value;
							},
						});
						return {};
					},
					{ lifetime: "host" },
				);
				click = () => api.root((ctx) => api.registry(Actions).get("addSample", ctx)!(ctx));
			},
			{ uses: [TodoStore] },
		),
	};
	const host = createHost({ self: "server" });
	await host.load([menuFacet, storeFacet], { awaitHostObjects: false });
	await host.ready();
	assert.equal(await click!(), 1);
	assert.equal(host.registry(Actions).table().size, 1);
	// end-example:08
});

it("09: compatible reload, migration and an old-contract adapter", { timeout: 5000 }, async () => {
	checkExamples("09");
	onTestFinished(() => host.close());
	// example:09-compatible
	const host = createHost({ self: "server" });
	const facet = (label: string): Facet => ({
		name: "todos",
		setup: (api) =>
			api.serve(TodoStore, (input, principal, self) => ({
				...todoFactory(input, principal, self),
				label: () => label,
			})),
	});
	await host.load([facet("Original")]);
	const todos = await host.get(TodoStore, { list: "family" });
	await todos.add({ text: "Buy milk" });
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const oldRoot = host.root(async (ctx) => {
		const first = await todos.label(ctx);
		entered.resolve();
		await resume.promise; // Test-only pause: pin an old caller during reload.
		return [first, await todos.label(ctx)];
	});
	await entered.promise;
	const compatible = await host.reload([facet("Updated")]);
	assert.deepEqual(compatible.gated, []);
	assert.equal(await todos.label(), "Updated");
	resume.resolve();
	assert.deepEqual(await oldRoot, ["Original", "Original"]);
	assert.equal(todos.rows.value?.[0]?.text, "Buy milk");
	// end-example:09-compatible
	// example:09-migrate
	const events: string[] = [];
	const stopEvents = todos.rows.events((event) => events.push(event.type));
	const migrated = await host.reload([
		{
			name: "todos",
			setup: (api) =>
				api.serve(
					TodoStore,
					todoStore({
						version: 2,
						migrate: (old, from) => {
							assert.equal(from, 1);
							return (old as Static<typeof Rows>).map((todo) => ({ ...todo, text: todo.text.toUpperCase() }));
						},
					}),
				),
		},
	]);
	assert.equal(migrated.gated.length, 1);
	assert.deepEqual(todos.rows.value, [{ text: "BUY MILK", done: false }]);
	assert.deepEqual(events, ["snap", "reset"]);
	stopEvents();
	// end-example:09-migrate
	// example:09-contract
	// Remove label from the new provider's contract: it is now called heading.
	const { label: _label, ...members } = TodoStore.def.members;
	const RenamedStore = local("tutorial.todos", {
		version: 2,
		input: TodoStore.def.input,
		members: { ...members, heading: method(undefined, Type.String()) },
	});
	await host.reload([
		{
			name: "todos",
			setup: (api) =>
				api.serve(
					RenamedStore,
					(input, principal, self) => {
						const { label, ...implementation } = todoStore({ version: 2 })(input, principal, self);
						return { ...implementation, heading: label };
					},
					{
						accepts: {
							1: (current) => ({ ...current, label: current.heading }),
						},
					},
				),
		},
	]);
	assert.equal(await todos.label(), "Todos for family");
	const newer = await host.get(RenamedStore, { list: "family" });
	assert.equal(await newer.heading(), "Todos for family");
	assert.equal(todos.rows.value?.[0]?.text, "BUY MILK");
	// end-example:09-contract
});

it("10: stub a provider with a fake facet and check error codes", { timeout: 5000 }, async () => {
	checkExamples("10");
	onTestFinished(() => host.close());
	// example:10
	const host = createHost<Principal>({ name: "server", self: "server", dev: true });
	const received: string[] = [];
	const fake: Facet = {
		name: "fake-store",
		...defineFacet((api: FacetApi) => {
			api.serve(TodoStore, (input, principal, self) => ({
				...todoFactory(input, principal, self),
				add: ({ text }) => {
					received.push(text);
				},
			}));
		}),
	};
	await host.load([fake]);
	serveViews(host);
	const owner = await host.get(Todos, { list: "family" }, { principal: "owner" });
	assert.ok(owner.variant === "editor");
	await owner.add({ text: "Test delegation" });
	assert.deepEqual(received, ["Test delegation"]);
	await assert.rejects(owner.add({ text: "" }), (error) => isChordError(error, "invalid"));
	owner.release();
	await assert.rejects(owner.add({ text: "Too late" }), (error) => isChordError(error, "released"));
	// end-example:10
});

it("11: short roots release temporary holds", { timeout: 5000 }, async () => {
	checkExamples("11");
	onTestFinished(() => host.close());
	// example:11
	const host = createHost({ self: "server" });
	host.serve(TodoStore, todoFactory);
	const screen = await host.get(TodoStore, { list: "family" });
	await host.root(async (ctx) => {
		const temporary = await ctx.get(TodoStore, { list: "family" });
		await temporary.add({ text: "Keep roots short" }, ctx);
	}); // The temporary reference is released here; screen still holds the store.
	assert.equal(screen.openCount.value, 1);
	screen.release(); // No reference remains; without persistence, disposal loses these rows.
	// end-example:11
});
