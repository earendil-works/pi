// Tests of the active theme of a client (slice 11 §4b) and of theme choices on the server: a client follows the
// `Themes` registry, its principal's `ThemeChoice` and its mode; choices are kept per principal across restarts.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	createHost,
	defineFacet,
	followActiveTheme,
	hostKind,
	memoryLinkPair,
	openStore,
	sqliteBackend,
	type Theme,
	ThemeChoice,
	Themes,
	themeChoiceFacet,
	themesFacet,
} from "../../src/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";

type TestPrincipal = { readonly kind: "server" } | { readonly kind: "user"; readonly id: string };

const COLORS = {
	accent: "#111111",
	bg: "#000000",
	fg: "#ffffff",
	muted: "#888888",
	error: "#f00",
	warning: "#ff0",
	success: "#0f0",
};

const theme = (id: string, mode: Theme["mode"]): Theme => ({ id, name: id, mode, colors: COLORS });

/** A server with theme choices, and a client of `user` with themes `themes` contributed by a plugin. */
async function setup(user: string, themes: readonly Theme[]) {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const server = createHost<TestPrincipal>({
		address: hostKind("server")(),
		principal: { kind: "server" },
		store,
		onError: () => {},
	});
	await server.load([{ name: "chord.themes.choice", facet: themeChoiceFacet<TestPrincipal>() }], context);
	const client = createHost<TestPrincipal>({ onError: () => {} });
	await client.load(
		[
			{ name: "chord.themes", facet: themesFacet<TestPrincipal>() },
			...themes.map((each, index) => ({
				name: `@test/theme-${index}`,
				facet: defineFacet<TestPrincipal>((_host, self) => self.contribute(Themes, each)),
			})),
		],
		context,
	);
	const [mine, theirs] = memoryLinkPair();
	server.accept(theirs, { principal: { kind: "user", id: user } }, context);
	client.connect(mine, { principal: { kind: "server" } }, context);
	return { server, client };
}

/** Waits until `check` holds. */
async function until(check: () => boolean): Promise<void> {
	for (let index = 0; index < 200 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
}

describe("following the active theme", () => {
	it("follows the registry, the principal's pick and the mode", async () => {
		const { server, client } = await setup("ada", [
			theme("night", "dark"),
			theme("dusk", "dark"),
			theme("paper", "light"),
		]);
		const seen: string[] = [];
		const follower = await followActiveTheme(client, "dark", (active) => seen.push(active.id), context);
		await until(() => seen.at(-1) === "night");
		const choice = await client.get(ThemeChoice, {}, context);
		await choice.choose({ dark: "dusk", light: null }, context);
		await until(() => seen.at(-1) === "dusk");
		follower.setMode("light");
		expect(seen.at(-1)).toBe("paper");
		follower.stop();
		choice.release();
		await client.close(context);
		await server.close(context);
	});
});

describe("theme choices", () => {
	it("refuse an id over 128 characters (Opus M4, Fable L7)", async () => {
		const { server, client } = await setup("ada", []);
		const choice = await client.get(ThemeChoice, {}, context);
		await expect(choice.choose({ dark: "x".repeat(129), light: null }, context)).rejects.toMatchObject({
			code: "invalid",
		});
		await choice.choose({ dark: "x".repeat(128), light: null }, context);
		choice.release();
		await client.close(context);
		await server.close(context);
	});

	it("are kept per principal", async () => {
		const { server, client } = await setup("ada", []);
		const choice = await client.get(ThemeChoice, {}, context);
		expect(choice.pick.value).toEqual({ dark: null, light: null });
		await choice.choose({ dark: "dusk", light: "paper" }, context);
		await until(() => choice.pick.value.dark === "dusk");
		const other = createHost<TestPrincipal>({ onError: () => {} });
		await other.load([], context);
		const [mine, theirs] = memoryLinkPair();
		server.accept(theirs, { principal: { kind: "user", id: "grace" } }, context);
		other.connect(mine, { principal: { kind: "server" } }, context);
		const graces = await other.get(ThemeChoice, {}, context);
		expect(graces.pick.value).toEqual({ dark: null, light: null });
		choice.release();
		graces.release();
		await other.close(context);
		await client.close(context);
		await server.close(context);
	});
});
