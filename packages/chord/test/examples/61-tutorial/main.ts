// The tutorial's app (`docs/tutorial/book.md`): a shared todo app built with the app kit, one worker per list. Each
// numbered step is the tutorial's chapter of that number: the server and the owner's sign-in, a list on its worker,
// routes, the page, the terminal, a theme plugin added while the app runs, a second user, languages, an edit applied in
// place, and a list exported and imported. The lists plugin's own test is `plugins/lists/worker.test.ts`;
// `screenshots.ts` shows the page in Chromium.
// Run from packages/chord (with Node 26.5.1 or later the terminal client runs too; `--serve` keeps the app running):
//   node --conditions=source --experimental-strip-types test/examples/61-tutorial/main.ts
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { List } from "@todo/app/v1";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import {
	type ChordError,
	createHost,
	LocaleChoice,
	WebScripts,
	type WebSocketLike,
	webSocketLink,
} from "../../../src/index.ts";
import { type RunningTerminal, requireSandboxNode, startTerminal } from "../../../src/node/tui/index.ts";
import { type Item, Todos } from "./plugins/lists/contract.ts";
import { messages } from "./plugins/lists/messages.ts";
import type { TodoPrincipal } from "./src/principals.ts";
import { startTodo, todoDirectories } from "./start.ts";

const { base, dataDir, root } = await todoDirectories();

// 1. Start the app: the kit makes the data directory, the server's store and host, HTTP and the owner link. Nobody is
//    signed in yet, so the page answers 401. The owner opens the link: its page posts the token from the URL's fragment
//    and gets a session cookie.
const app = await startTodo(dataDir, root, context);
const link = new URL(app.ownerLink());
const url = link.origin;
console.log("1. owner link:", `http://127.0.0.1:<port>${link.pathname}#<token>`);
console.log("   data directory:", (await readdir(dataDir)).sort().join(", "));
console.log("   GET / signed out:", (await fetch(url)).status);
const signIn = await fetch(`${url}/_chord/owner`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ token: link.hash.slice(1) }),
});
const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
console.log("   the owner signs in:", signIn.status, cookie.replace(/=.*/, "=…"));
console.log("   GET / signed in:", (await fetch(url, { headers: { cookie } })).status);

// 2. A list on its own worker. Code acting as the owner gets the groceries list's `Todos`: the request goes to the
//    list's address, and the first one starts its worker. The same call in a root of the server acts as the server.
const OWNER = { kind: "owner" } as const;
await app.host.root(
	async (ctx) => {
		const todos = await ctx.get(Todos, { list: "groceries" });
		await todos.add("milk", ctx);
		await todos.add("eggs", ctx);
		await todos.tick({ id: 1, done: true }, ctx);
		await until(() => todos.items.value[0]?.done === true);
		console.log("2. as the owner:", todos.variant, "|", show(todos.items.value));
	},
	context,
	{ principal: OWNER },
);
await app.host.root(async (ctx) => {
	const todos = await ctx.get(Todos, { list: "groceries" });
	await todos.add("bread", ctx);
	await until(() => todos.items.value.length === 3);
	console.log("   as the server:", todos.variant, "|", show(todos.items.value.slice(-1)));
}, context);
const workers = join(dataDir, "workers", "list");
const [groceriesDir] = await readdir(workers);
console.log("   workers:", Object.keys(app.workers.get("list")!.state.value).join(", "));
console.log(`   workers/list/${groceriesDir}:`, (await readdir(join(workers, groceriesDir!))).sort().join(", "));

// 3. Routes. A command-line client on this machine sends the owner token file as a bearer token; the route's
//    `ctx.get` acts as the request's principal, so the todo is the owner's.
const token = (await readFile(app.ownerTokenFile, "utf8")).trim();
const cli = { authorization: `Bearer ${token}` };
const posted = await fetch(`${url}/api/lists/groceries`, {
	method: "POST",
	headers: { ...cli, "content-type": "application/json" },
	body: JSON.stringify("butter"),
});
console.log("3. POST /api/lists/groceries:", await posted.json());
const listed = (await (await fetch(`${url}/api/lists/groceries`, { headers: cli })).json()) as Item[];
console.log("   GET /api/lists/groceries:", show(listed));
console.log("   GET without a token:", (await fetch(`${url}/api/lists/groceries`)).status);

// 4. The page: the app's template with the base bundle, the plugins' combined script and their stylesheets. A watch
//    starts at the current value; its listener gets only what changes after.
const html = await (await fetch(url, { headers: cli })).text();
console.log("4. the page loads:");
for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) console.log(`   ${hashless(asset!)}`);
const groceries = await app.host.get(Todos, { list: "groceries" }, context);
const watch = await groceries.items.watch(context);
console.log("   watch.value:", done(watch.value), "done");
const changed = Promise.withResolvers<readonly Item[]>();
watch.start(async (call) => {
	if (call.kind === "value") changed.resolve(call.value);
});
await groceries.tick({ id: 2, done: true }, context);
console.log("   the listener's first call:", done(await changed.promise), "done");
await watch.stop();

// 5. The terminal client (Node 26.5.1 or later): the launcher signs in with the owner token file, downloads the
//    terminal's base bundle and the plugins' terminal scripts and runs them in its sandbox, here on a scripted terminal.
const frames: string[] = [];
let terminal: RunningTerminal | undefined;
if (sandboxAvailable()) {
	const output = Object.assign(new PassThrough(), { columns: 60, rows: 12 });
	output.on("data", (chunk: Buffer) => frames.push(chunk.toString()));
	terminal = await startTerminal({
		url,
		credentials: { kind: "file", path: app.ownerTokenFile },
		input: new PassThrough(),
		output,
		colors: "truecolor",
		// The machine's languages (its system locale by default), here fixed for the book's output.
		locales: ["en-US"],
	});
	await until(() => screen(frames).includes("butter"));
	console.log("5. the terminal shows:");
	for (const line of screen(frames).trim().split("\r\n")) console.log(`   ${line}`);
} else console.log("5. (the terminal client needs Node 26.5.1 or later for its sandbox)");

// 6. A theme plugin added while the app runs: a new directory in the plugins root marks the set changed, and applying
//    the changes builds it and rolls it out. Pages and terminals restyle in place.
await cp(fileURLToPath(new URL("./later/harbor/", import.meta.url)), join(root, "harbor"), { recursive: true });
await until(() => app.plugins.state.value.set);
const added = await app.applyChanges(context);
console.log("6. harbor added, rolled out to:", added.steps.map(({ name }) => name).join(", "));
const scripts = await app.host.get(WebScripts, {}, context);
console.log("   the page's plugins:", scripts.set.value.plugins.map(({ name }) => name).join(", "));
scripts.release();
if (terminal !== undefined) {
	await until(() => frames.join("").includes("\x1b[38;2;242;166;90mGroceries"));
	console.log(
		"   the terminal redraws its title in Harbor's accent:",
		JSON.stringify("\x1b[38;2;242;166;90mGroceries"),
	);
}

// 7. A second user. Ada picks a name (the kit's ephemeral login) and connects a client host of her own over the links
//    endpoint, as a page does. A host serves nothing before `load`: a client with nothing to load calls `load([])`.
const login = await fetch(`${url}/_chord/login`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ name: "ada" }),
});
const adaCookie = login.headers.get("set-cookie")!.split(";")[0]!;
const ada = createHost<TodoPrincipal>({ onError: (error) => console.error("ada:", error.kind) });
try {
	ada.hold(Todos, { list: "groceries" }, context);
} catch (error) {
	console.log("7. ada's hold before load:", (error as Error).message);
}
await ada.load([], context);
const socket = new WebSocket(`${url.replace(/^http/, "ws")}/chord`, { headers: { cookie: adaCookie } });
ada.connect(webSocketLink(socket as unknown as WebSocketLike), { principal: { kind: "server" } }, context);
const adas = await ada.get(Todos, { list: "groceries" }, context);
await adas.add("coffee", context);
console.log("   ada's variant:", adas.variant);
if (adas.variant === "member") {
	// @ts-expect-error `clear` is the owner's: TypeScript refuses it, and so does the worker.
	const clearing: Promise<null> = adas.clear(context);
	await clearing.catch((error: ChordError) => console.log("   ada's clear:", `${error.code}/${error.reason}`));
}
await until(() => groceries.items.value.some(({ by }) => by === "ada"));
console.log("   the server's reference sees:", show(groceries.items.value.slice(-1)));

// 8. Languages. The owner chooses German: a preference the server keeps per principal, which every client of the owner
//    follows, so the terminal redraws in German without restarting. Ada's pick is her own. Clearing the done todos
//    leaves a notice as data, a key and its parameters: the server's plain render is the English catalog, the
//    terminal renders the same state in German.
const ownerChooses = (locale: string) =>
	app.host.root(async (ctx) => (await ctx.get(LocaleChoice, {})).choose(locale, ctx), context, { principal: OWNER });
await ownerChooses("de");
console.log("8. the owner chooses German");
if (terminal !== undefined) {
	await until(() => screen(frames).includes("Einkäufe"));
	console.log("   the terminal shows:");
	for (const line of screen(frames).trim().split("\r\n")) console.log(`   ${line}`);
}
const adasChoice = await ada.get(LocaleChoice, {}, context);
await adasChoice.choose("fr", context);
console.log("   ada's pick:", adasChoice.pick.value);
adasChoice.release();
await app.host.root(
	async (ctx) => {
		const todos = await ctx.get(Todos, { list: "groceries" });
		if (todos.variant === "owner") await todos.clear(ctx);
	},
	context,
	{ principal: OWNER },
);
await until(() => groceries.notice.value !== null);
console.log("   the notice:", groceries.notice.value);
console.log("   the server renders it:", messages.render(groceries.notice.value!));
if (terminal !== undefined) {
	await until(() => screen(frames).includes("entfernt"));
	console.log("   the terminal renders it:", screen(frames).trim().split("\r\n").at(-1));
}

// 9. An edit applied in place: the lists plugin's worker facet trims a todo's text, so a blank one is empty and the
//    store refuses it with Chord's `invalid/args`, which reaches Ada as it would a refused argument. The
//    watcher marks the plugin dirty; applying the changes rolls it out to the server, the list's worker, the page and
//    the terminal. On the worker each object of the plugin takes its fate: the store opens no native, so it is swapped
//    in place (its live query runs again); the views wait for it, then go on with the new code. Ada's
//    reference follows them.
// The edit: `add` in the `Todos` view, before and after.
const BEFORE = "add: (text: string, ctx: Ctx) => store.add({ text, by }, ctx),";
const AFTER = "add: (text: string, ctx: Ctx) => store.add({ text: text.trim(), by }, ctx),";
const workerFile = join(root, "lists", "worker.ts");
await writeFile(workerFile, (await readFile(workerFile, "utf8")).replace(BEFORE, AFTER));
await until(() => app.plugins.state.value.dirty.includes("@todo/lists"));
const applied = await app.applyChanges(context);
console.log("9. lists changed, rolled out to:", applied.steps.map(({ name }) => name).join(", "));
for (const host of applied.steps.find(({ name }) => name === "list")!.hosts) {
	const fates = "report" in host ? host.report.objects.map(({ object, kind }) => `${object} ${kind}`) : [];
	console.log(`   on ${host.host}:`, [...new Set(fates)].join(", "));
}
await adas.add("  tea  ", context);
await until(() => groceries.items.value.at(-1)?.text === "tea");
console.log("   ada adds '  tea  ':", show(groceries.items.value.slice(-1)));
const refused = await adas.add(" ", context).then(
	() => "added",
	(error: ChordError) => ({ code: error.code, reason: error.reason }),
);
console.log("   ada adds ' ':", refused);

// 10. Export and import. The list's running worker writes its own store and files as one archive and goes on; importing
//    the archive makes a new list with the same todos. An address that has data is never overwritten.
const archive = join(base, "groceries.tar");
await app.exportData(List({ id: "groceries" }), archive, context);
console.log("10. exported groceries:", (await readFile(archive)).length > 0 ? "an archive" : "nothing");
await app.importData(archive, List({ id: "picnic" }), context);
const picnic = await app.host.get(Todos, { list: "picnic" }, context);
console.log("   imported as picnic:", show(picnic.items.value));
picnic.release();
await app.importData(archive, List({ id: "groceries" }), context).catch((error: Error) => {
	console.log("   importing over groceries:", error.message.replace(base, "…"));
});

if (process.argv.includes("--serve")) {
	console.log(`Open ${app.ownerLink()} (Ctrl-C to stop); terminal: 57-tui's terminal.ts with ${app.ownerTokenFile}`);
} else {
	await terminal?.stop();
	groceries.release();
	adas.release();
	await ada.close(context);
	await app.close(context);
	await rm(base, { recursive: true, force: true });
	console.log("11. closed");
}

/** Todos as one line: `[x] milk (owner), [ ] eggs (owner)`. */
function show(items: readonly Item[]): string {
	return items.map((item) => `${item.done ? "[x]" : "[ ]"} ${item.text} (${item.by})`).join(", ");
}

/** How many of `items` are done. */
function done(items: readonly Item[]): number {
	return items.filter((item) => item.done).length;
}

/** Waits until `check` holds. */
async function until(check: () => boolean): Promise<void> {
	while (!check()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** An asset's URL with its content hash masked, so the output is the same at every run. */
function hashless(asset: string): string {
	return asset.replace(/\.[0-9a-f]{8,}\./, ".<hash>.");
}

/** The terminal's last frame as text (its colours stripped). */
function screen(written: readonly string[]): string {
	return written
		.join("")
		.split("\x1b[2J\x1b[H")
		.at(-1)!
		.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Whether this Node can run the terminal's sandbox. */
function sandboxAvailable(): boolean {
	try {
		requireSandboxNode();
		return true;
	} catch {
		return false;
	}
}
