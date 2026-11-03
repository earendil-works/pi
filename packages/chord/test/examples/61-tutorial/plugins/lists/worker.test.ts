// The lists plugin's worker facet, tested alone with `testPlugin`: built as production builds it, evaluated with the
// app's real API module and loaded on a host of its own (an in-memory store) at a list's address. Each test runs code
// as a principal of its choice: a user gets the `member` variant, the owner `owner`; a todo keeps who added it.
// Run from packages/chord:
//   node ../../node_modules/vitest/dist/cli.js --run test/examples/61-tutorial/plugins/lists/worker.test.ts
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../../../src/context/index.ts";
import { type TestedPlugin, testPlugin } from "../../../../../src/node/plugins/index.ts";
import * as v1 from "../../src/api/v1/index.ts";
import type { TodoPrincipal } from "../../src/principals.ts";

const ADA = { kind: "user", id: "u1", name: "ada" } as const;
const OWNER = { kind: "owner" } as const;

describe("the lists plugin on a list's worker", () => {
	let t: TestedPlugin<TodoPrincipal>;
	beforeEach(async () => {
		t = await testPlugin<TodoPrincipal>(
			fileURLToPath(new URL("./", import.meta.url)),
			{
				kind: "worker",
				api: { name: "@todo/app", versions: ["v1"] },
				modules: { "@todo/app/v1": v1 },
				address: v1.List({ id: "groceries" }),
				principal: { kind: "worker", list: "list|groceries" },
			},
			context,
		);
	});
	afterEach(() => t.close(context));

	it("adds a todo as the principal that called", async () => {
		await t.root(
			async (ctx) => {
				const todos = await ctx.get(v1.Todos, { list: "groceries" });
				expect(todos.variant).toBe("member");
				await todos.add("coffee", ctx);
				expect(todos.items.value.map(({ text, by }) => `${text} (${by})`)).toEqual(["coffee (ada)"]);
			},
			context,
			{ principal: ADA },
		);
	});

	it("lets the owner clear the done todos", async () => {
		await t.root(
			async (ctx) => {
				const todos = await ctx.get(v1.Todos, { list: "groceries" });
				if (todos.variant !== "owner") throw new Error(`the owner got ${todos.variant}`);
				await todos.add("milk", ctx);
				await todos.add("eggs", ctx);
				await todos.tick({ id: 1, done: true }, ctx);
				await todos.clear(ctx);
				expect(todos.items.value.map(({ text }) => text)).toEqual(["eggs"]);
			},
			context,
			{ principal: OWNER },
		);
		expect(t.unserved()).toEqual([]);
	});
});
