import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getKeybindings, stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { loadLocalPreferences } from "../../src/hosts/tui-local-preferences.ts";
import { defineFacet } from "../../src/runtime/chord.ts";
import { TuiRuntime, tuiFacet } from "../../src/runtime/tui.ts";
import { canOverlap, parseWhen, type TuiCommand, TuiCommands } from "../../src/runtime/tui-commands.ts";
import { hotkeysText, tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { builtinKeybindings, resolvePrivilegedKeys, sanitizeKeybindings } from "../../src/tui/keybindings.ts";
import { poll, testHost } from "./helpers.ts";

const CTRL_V = "\x16";
const CTRL_K = "\x0b";
const F1 = "\x1bOP";
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

function commandsFacet(_name: string, commands: Record<string, TuiCommand>) {
	return defineFacet((_host, self) => self.contribute(TuiCommands, commands));
}
/** Commands-only chat slot whose contexts the test controls. */
const chatContexts = new Set<string>();
const chatSlot = tuiFacet("chat", () => ({
	render: () => ["chat"],
	invalidate() {},
	dispose() {},
	contexts: () => chatContexts,
}));
async function runtimeWith(t: { after(fn: () => unknown): void }, ...facets: ReturnType<typeof defineFacet>[]) {
	chatContexts.clear();
	const fixture = await testHost({ facets: [tuiCoreFacet, chatSlot, ...facets] });
	t.after(() => fixture.close());
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TuiAltScreen(terminal);
	const runtime = new TuiRuntime(fixture.host, tui);
	await runtime.start();
	// The worker runtime's wiring: input reaches the runtime through pi-tui (stage 2 runs first).
	tui.setLayoutRoot(runtime.root);
	tui.setFocus(runtime);
	tui.start();
	t.after(() => {
		tui.stop();
		runtime.dispose();
	});
	return { fixture, runtime, send: (data: string) => terminal.sendInput(data) };
}

test("when expressions parse, evaluate and detect overlap under exclusive groups", () => {
	const chat = parseWhen("chat && editorEmpty && !overlay");
	assert.equal(chat.specificity, 3);
	assert.deepEqual([...chat.positive].sort(), ["chat", "editorEmpty"]);
	assert(canOverlap(parseWhen("chat"), parseWhen("busy")));
	assert(!canOverlap(parseWhen("chat"), parseWhen("sessions"), [["chat", "sessions"]]));
	assert(!canOverlap(parseWhen("busy"), parseWhen("!busy")));
	assert(canOverlap(parseWhen("chat || (sessions && owner)"), parseWhen("owner")));
	assert.throws(() => parseWhen("chat &&"), /Invalid when/);
	assert.throws(() => parseWhen("(chat"), /missing/);
});

test("privileged keys: same pi default collision kept (search next), other collisions lose and are reported", () => {
	const definitions = builtinKeybindings();
	const defaults = resolvePrivilegedKeys(definitions, {});
	// pi resolves Ctrl+G (external editor / search next) by mode; the worker suspends interception while searching.
	assert.deepEqual(defaults.keys["app.editor.external"], ["ctrl+g"]);
	assert.deepEqual(defaults.keys["app.clipboard.pasteImage"], ["ctrl+v"]);
	assert.deepEqual(defaults.lost, []);
	const user = resolvePrivilegedKeys(definitions, { "app.model.select": "ctrl+v", "plugin.thing": "ctrl+x" });
	assert.deepEqual(user.keys["app.clipboard.pasteImage"], []);
	assert.deepEqual(user.keys["app.message.copy"], []);
	assert.deepEqual(
		user.lost.map(({ id, to }) => [id, to]),
		[
			["app.clipboard.pasteImage", "app.model.select"],
			["app.message.copy", "plugin.thing"],
		],
	);
	// A user who rebinds search-next onto the editor key keeps it for search; the launcher action loses it.
	const rebound = resolvePrivilegedKeys(definitions, {
		"app.editor.external": "ctrl+g",
		"tui.altScreen.searchNext": "ctrl+g",
	});
	assert.deepEqual(rebound.keys["app.editor.external"], []);
});

test("pi keybindings.json: legacy names migrate, invalid entries are reported, the user override drives dispatch", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-tui-keys-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const agentDir = join(directory, "agent");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "keybindings.json"),
		JSON.stringify({
			selectModel: "ctrl+k",
			"app.model.select": "ctrl+k",
			bogus: "hyper+q",
			"tui.editor.undo": ["ctrl+z"],
		}),
	);
	const preferences = loadLocalPreferences({ agentDir, configDir: join(directory, "p2") });
	assert.deepEqual(preferences.keybindings, { "app.model.select": "ctrl+k", "tui.editor.undo": ["ctrl+z"] });
	assert.deepEqual(preferences.problems, ["keybindings.json: invalid binding bogus"]);
	assert.deepEqual(sanitizeKeybindings({ cycleModelForward: "ctrl+o" }).config, {
		"app.model.cycleForward": "ctrl+o",
	});

	let selected = 0;
	const { runtime, send } = await runtimeWith(
		t,
		commandsFacet("model", { "app.model.select": { title: "Select model", run: () => void selected++ } }),
	);
	await poll(() => runtime.commands.list().some((item) => item.id === "app.model.select"));
	runtime.appearance.update({ local: preferences });
	assert.deepEqual(runtime.keys.getKeys("app.model.select"), ["ctrl+k"]);
	assert.equal(getKeybindings(), runtime.keys, "the rebuilt manager is installed for pi-tui components");
	send("\x0c");
	assert.equal(selected, 0, "Ctrl+L no longer selects");
	send(CTRL_K);
	assert.equal(selected, 1);
});

test("plugin vs plugin: specificity, user bindings, registration order and conflict reports", async (t) => {
	const ran: string[] = [];
	const command = (id: string, when?: string, keys: TuiCommand["keys"] = "ctrl+y"): TuiCommand => ({
		title: id,
		keys,
		when,
		run: () => void ran.push(id),
	});
	const { runtime, send } = await runtimeWith(
		t,
		commandsFacet("a", { "alpha.one": command("alpha.one", "sessions"), "alpha.two": command("alpha.two", "chat") }),
		commandsFacet("b", {
			"beta.one": command("beta.one", "sessions"),
			"beta.chat": command("beta.chat", "chat && busy"),
			// Plugin defaults never claim launcher keys; transcript keys are reported (the alt screen consumes them).
			"beta.paste": command("beta.paste", undefined, ["ctrl+v", "ctrl+u"]),
			"beta.top": command("beta.top", "chat", "ctrl+home"),
		}),
	);
	await poll(() => runtime.commands.list().some((item) => item.id === "beta.top"));
	const conflicts = runtime.commands.conflicts.map((conflict) => conflict.message);
	assert(
		conflicts.includes("ctrl+y: alpha.one and beta.one; alpha.one wins (registered first)"),
		conflicts.join("\n"),
	);
	assert(!conflicts.some((message) => message.includes("alpha.two and beta.chat")), "more specific: no conflict");
	assert(!conflicts.some((message) => message.includes("alpha.one and alpha.two")), "screens are exclusive");
	assert(conflicts.includes("ctrl+v: launcher-owned; dropped from beta.paste's defaults"));
	assert(conflicts.includes("ctrl+home: tui.altScreen.top (transcript) wins over beta.top"));
	assert.deepEqual(runtime.ctx.keys.getKeys("beta.paste"), ["ctrl+u"]);

	runtime.navigate("sessions");
	send("\x19");
	assert.deepEqual(ran, ["alpha.one"]);
	// A user binding wins over a default at equal specificity.
	runtime.appearance.update({
		local: { keybindings: { "beta.one": "ctrl+y" }, settings: {}, themes: {}, problems: [] },
	});
	send("\x19");
	assert.deepEqual(ran, ["alpha.one", "beta.one"]);
	runtime.navigate("chat");
	send("\x19");
	assert.equal(ran.at(-1), "alpha.two");
	chatContexts.add("busy");
	send("\x19");
	assert.equal(ran.at(-1), "beta.chat", "the more specific context wins");
	send(CTRL_V);
	send("\x1b[1;5H");
	assert.equal(ran.at(-1), "beta.chat", "neither the launcher key nor the transcript key reached a plugin command");
});

test("duplicate slash names disable the later slash form only; /hotkeys reports it", async (t) => {
	const ran: string[] = [];
	const { runtime } = await runtimeWith(
		t,
		commandsFacet("a", {
			"alpha.go": { title: "Alpha", slash: { name: "go" }, run: (_ctx, args) => void ran.push(`alpha:${args}`) },
		}),
		commandsFacet("b", {
			"beta.go": { title: "Beta", slash: { name: "go" }, run: (_ctx, args) => void ran.push(`beta:${args ?? ""}`) },
			"beta.bad": { title: "Bad", slash: { name: "Not Valid" }, run: () => {} },
		}),
	);
	await poll(() => runtime.commands.list().some((item) => item.id === "beta.go"));
	assert(runtime.ctx.commands.runSlash("/go now"));
	assert(runtime.ctx.commands.run("beta.go"), "the id stays usable");
	assert.deepEqual(ran, ["alpha:now", "beta:"]);
	assert(!runtime.ctx.commands.runSlash("/unknown"));
	const help = plain(hotkeysText(runtime.ctx));
	assert.match(help, /\/go: alpha\.go keeps it; disabled for beta\.go/);
	assert.match(help, /\/Not Valid of beta\.bad is not a valid name/);
	assert.match(help, /Launcher-owned/);
	assert.match(help, /ctrl\+g\s+Open external editor/);
	const suggestions = await runtime.commands.autocomplete.getSuggestions(["/g"], 0, 2, {
		signal: new AbortController().signal,
	});
	// "go" once (the disabled duplicate has no slash form) and first (fuzzy ranking; other names may also match "g").
	const values = suggestions?.items.map((item) => item.value) ?? [];
	assert.equal(values[0], "go");
	assert.equal(values.filter((value) => value === "go").length, 1);
});

test("registry reload replaces commands without stale handlers and closes their overlays", async (t) => {
	const ran: string[] = [];
	const facet = (label: string) =>
		commandsFacet("sample", { "sample.act": { title: "Act", keys: "ctrl+y", run: () => void ran.push(label) } });
	const { fixture, runtime, send } = await runtimeWith(t, facet("old"));
	await poll(() => runtime.commands.list().some((item) => item.id === "sample.act"));
	send("\x19");
	const overlay = runtime.ctx.overlay("sample", { render: () => ["overlay"], invalidate() {} });
	await fixture.reload([tuiCoreFacet, chatSlot, facet("new")]);
	await poll(() => overlay.closed);
	send("\x19");
	assert.deepEqual(ran, ["old", "new"]);
});

test("overlay precedence, empty-editor exit, palette and /hotkeys through the dispatcher", async (t) => {
	let exited = 0;
	const ran: string[] = [];
	const { runtime, send } = await runtimeWith(
		t,
		commandsFacet("x", {
			"x.close": { title: "Close", keys: "ctrl+y", when: "overlay:x", run: () => void ran.push("close") },
			"x.global": { title: "Global", keys: "ctrl+y", run: () => void ran.push("global") },
			"x.target": { title: "Palette target", run: () => void ran.push("palette") },
		}),
	);
	runtime.onExit = () => void exited++;
	await poll(() => runtime.commands.list().some((item) => item.id === "x.close"));
	runtime.navigate("chat");
	chatContexts.add("editorFocused");
	send("\x04");
	assert.equal(exited, 0, "Ctrl+D with text deletes forward instead");
	chatContexts.add("editorEmpty");
	send("\x04");
	assert.equal(exited, 1);

	// Stage 3: overlay-scoped commands, then the overlay; global commands do not run under an overlay.
	const input: string[] = [];
	const overlay = runtime.ctx.overlay("x", {
		render: () => [],
		invalidate() {},
		handleInput: (data) => void input.push(data),
	});
	assert(runtime.contexts().has("overlay:x"));
	send("\x19");
	send("a");
	send("\x04");
	assert.deepEqual(ran, ["close"]);
	assert.deepEqual(input, ["a", "\x04"]);
	assert.equal(exited, 1);
	overlay.close();
	send("\x19");
	assert.deepEqual(ran, ["close", "global"]);

	send(F1);
	assert(runtime.contexts().has("overlay:palette"));
	for (const char of "palette target") send(char);
	send("\r");
	assert.deepEqual(ran, ["close", "global", "palette"]);
	assert(!runtime.contexts().has("overlay"));
	assert(runtime.ctx.commands.runSlash("/hotkeys"));
	assert(runtime.contexts().has("overlay:hotkeys"));
	send("\x1b");
	assert(!runtime.contexts().has("overlay"));
});
