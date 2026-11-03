// Screenshots of the tutorial's page (`docs/tutorial/screens/`), taken in headless Chromium: the page after the owner
// signed in with the owner link, the page in the Harbor theme added while it runs, the page after an edit of the
// lists plugin's web facet applied in place, and the page after the owner chose French, with the list's notice.
// Run from packages/chord, with Chromium (`CHROMIUM_BIN`, else `chromium-docker` on the `PATH`):
//   node --conditions=source --experimental-strip-types test/examples/61-tutorial/screenshots.ts docs/tutorial/screens
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { LocaleChoice } from "../../../src/index.ts";
import { Browser, CHROMIUM } from "../../node/web/browser.ts";
import { Todos } from "./plugins/lists/contract.ts";
import { startTodo, todoDirectories } from "./start.ts";

const out = resolve(process.argv[2] ?? "screens");
if (CHROMIUM === undefined) throw new Error("no Chromium: set CHROMIUM_BIN");
await mkdir(out, { recursive: true });
const { base, dataDir, root } = await todoDirectories();
const app = await startTodo(dataDir, root, context);

// The list as the tutorial leaves it after chapter 7: the owner's todos, one by the server, one by Ada.
const as = async (principal: Parameters<typeof app.host.root>[2], texts: readonly string[]): Promise<void> => {
	await app.host.root(
		async (ctx) => {
			const todos = await ctx.get(Todos, { list: "groceries" });
			for (const text of texts) await todos.add(text, ctx);
		},
		context,
		principal,
	);
};
await as({ principal: { kind: "owner" } }, ["milk", "eggs"]);
await as(undefined, ["bread"]);
await as({ principal: { kind: "owner" } }, ["butter"]);
await as({ principal: { kind: "user", id: "u1", name: "ada" } }, ["coffee"]);
await app.host.root(
	async (ctx) => (await ctx.get(Todos, { list: "groceries" })).tick({ id: 1, done: true }, ctx),
	context,
	{ principal: { kind: "owner" } },
);

/** The edit of step 3: a line counting the open todos above the list, in the page's language. */
const BEFORE = `h(
			"ul",`;
const AFTER = `h("p", { className: "lists-open" }, t("open", items.filter((item) => !item.done).length)),
		h(
			"ul",`;

const browser = await Browser.start();
const shoot = async (name: string): Promise<void> => {
	await new Promise((done) => setTimeout(done, 300));
	const { data } = (await browser.call("Page.captureScreenshot", { format: "png" })) as { readonly data: string };
	await writeFile(join(out, name), Buffer.from(data, "base64"));
	console.log(`wrote ${join(out, name)}`);
};
try {
	await browser.call("Emulation.setDeviceMetricsOverride", {
		width: 560,
		height: 430,
		deviceScaleFactor: 1,
		mobile: false,
	});

	// 1. The owner opens the owner link: the kit's page signs them in and goes to the app's page.
	await browser.open(app.ownerLink());
	await browser.wait("document.querySelectorAll('.lists-panel li').length === 5");
	await shoot("page.png");

	// 2. The Harbor theme plugin added and applied; the browser prefers dark, so the page takes Harbor.
	await cp(fileURLToPath(new URL("./later/harbor/", import.meta.url)), join(root, "harbor"), { recursive: true });
	while (!app.plugins.state.value.set) await new Promise((done) => setTimeout(done, 10));
	await app.applyChanges(context);
	await browser.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await browser.wait("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#12232e'");
	await shoot("harbor.png");

	// 3. Half a todo typed, then an edit of the lists plugin's web facet applied: a count of the open todos. The panel
	//    remounts (new code), and the half-typed todo is still there: the page keeps it (`usePageState`).
	await browser.evaluate("document.querySelector('.lists-panel input').focus()");
	await browser.type("oat mi");
	// A mark on the page's window: a page that reloaded would have lost it.
	await browser.evaluate("window.marked = true");
	const typed = await browser.evaluate<string>("document.querySelector('.lists-panel input').value");
	const file = join(root, "lists", "web.ts");
	await writeFile(file, (await readFile(file, "utf8")).replace(BEFORE, AFTER));
	while (!app.plugins.state.value.dirty.includes("@todo/lists")) await new Promise((done) => setTimeout(done, 10));
	await app.applyChanges(context);
	await browser.wait("document.querySelector('.lists-open') !== null");
	await browser.evaluate("document.querySelector('.lists-panel input').focus()");
	await shoot("edited.png");
	const after = await browser.evaluate<string>("document.querySelector('.lists-panel input').value");
	console.log(`typed ${JSON.stringify(typed)}; after the edit: ${JSON.stringify(after)}`);

	// 4. The owner chooses French and clears the done todos: the page re-renders in French with the list's notice, the
	//    half-typed todo still there.
	await app.host.root(
		async (ctx) => {
			await (await ctx.get(LocaleChoice, {})).choose("fr", ctx);
			const todos = await ctx.get(Todos, { list: "groceries" });
			if (todos.variant === "owner") await todos.clear(ctx);
		},
		context,
		{ principal: { kind: "owner" } },
	);
	await browser.wait("document.querySelector('.lists-notice')?.textContent === 'owner a retiré les tâches faites'");
	await browser.evaluate("document.querySelector('.lists-panel input').focus()");
	await shoot("french.png");
	const french = await browser.evaluate<string>("document.querySelector('.lists-panel input').value");
	const lang = await browser.evaluate<string>("document.documentElement.lang");
	console.log(`after choosing French: lang="${lang}", ${JSON.stringify(french)} still typed`);
	console.log("the page did not reload:", await browser.evaluate<boolean>("window.marked === true"));
} finally {
	await browser.close();
	await app.close(context);
	await rm(base, { recursive: true, force: true });
}
