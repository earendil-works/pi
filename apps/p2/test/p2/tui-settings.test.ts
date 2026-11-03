import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { launcherActions } from "../../src/hosts/tui-actions.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { loadLocalPreferences, watchLocalPreferences } from "../../src/hosts/tui-local-preferences.ts";
import { applyPrefsPatch, prefsDiff, validatePrefsPatch } from "../../src/hosts/tui-prefs-save.ts";
import { TuiRuntime } from "../../src/runtime/tui.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { restoreRuntime, snapshotRuntime } from "../../src/tui/snapshot.ts";
import { LIGHT_THEME } from "../../src/tui/theme/builtin-themes.ts";
import { createTheme } from "../../src/tui/theme/theme.ts";
import { holdIn, poll, startFixture, testHost } from "./helpers.ts";

const supported = Number(process.versions.node.split(".")[0]) >= 26;

test("savePrefs patches: privileged bindings, the editor command and launcher-only keys are refused", () => {
	const refused = (patch: unknown) => "error" in validatePrefsPatch(patch);
	assert(refused({ keybindings: { "app.clipboard.pasteImage": "ctrl+y" } }));
	assert(refused({ keybindings: { "app.editor.external": null } }));
	assert(refused({ keybindings: { "p2.attach": "f5" } }));
	assert(refused({ settings: { externalEditor: "vim" } }));
	assert(refused({ externalEditor: "vim" }));
	assert(refused({ mouse: "off" }));
	assert(refused({ downloads: "/tmp" }));
	assert(refused({ keybindings: { "app.model.select": "hyper+q" } }));
	assert(refused({ settings: { editorPaddingX: 9 } }));
	assert(refused({ theme: "a/b/c" }));
	assert(refused("nope"));
	const ok = validatePrefsPatch({
		keybindings: { "app.model.select": "ctrl+k", "app.tools.expand": null, "p2.palette": [] },
		theme: "light",
		settings: { hideThinkingBlock: true, terminal: { showImages: false, imageWidthCells: null } },
	});
	assert(!("error" in ok));
	const before = {
		keybindings: { "app.tools.expand": "ctrl+e" },
		settings: { terminal: { imageWidthCells: 80 } },
		mouse: "on",
		externalEditor: "vim",
	};
	const after = applyPrefsPatch(before, ok.patch);
	assert.deepEqual(after, {
		keybindings: { "app.model.select": "ctrl+k", "p2.palette": [] },
		settings: { terminal: { showImages: false }, hideThinkingBlock: true },
		mouse: "on",
		externalEditor: "vim",
		theme: "light",
	});
	assert.deepEqual(prefsDiff({}, { theme: "x" }), ['+ theme: "x"'], "a new file shows only what is added");
	assert.deepEqual(prefsDiff(before, after), [
		'+ keybindings.app.model.select: "ctrl+k"',
		'- keybindings.app.tools.expand: "ctrl+e"',
		"+ keybindings.p2.palette: []",
		"+ settings.hideThinkingBlock: true",
		"- settings.terminal.imageWidthCells: 80",
		"+ settings.terminal.showImages: false",
		'+ theme: "light"',
	]);
});

test("savePrefs action: the diff is shown first; the write is atomic and keeps everything else", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-prefs-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, "prefs.json"), JSON.stringify({ mouse: "off", theme: "dark" }));
	const save = launcherActions({
		url: new URL("http://127.0.0.1:1"),
		credentials: {},
		role: "guest",
		prefsDirectory: directory,
	}).savePrefs;
	assert(save?.kind === "C");
	const context = { origin: new URL("http://127.0.0.1:1"), target: undefined };
	assert.equal(save.consent({ patch: { keybindings: { "app.message.copy": "ctrl+y" } } }, context), undefined);
	assert.equal(save.consent({ patch: { theme: "dark" } }, context), undefined, "nothing changes: nothing to ask");
	const consent = save.consent({ patch: { theme: "light" } }, context);
	assert.equal(consent?.preview, '- theme: "dark"\n+ theme: "light"');
	assert.deepEqual(consent?.facts, [["File", join(directory, "prefs.json")]]);
	assert.equal(JSON.parse(readFileSync(join(directory, "prefs.json"), "utf8")).theme, "dark", "not before running");
	await save.run({ patch: { theme: "light" } }, undefined as never);
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "prefs.json"), "utf8")), { mouse: "off", theme: "light" });
	assert.equal(statSync(join(directory, "prefs.json")).mode & 0o777, 0o600);
	await assert.rejects(save.run({ patch: { settings: { externalEditor: "x" } } }, undefined as never));
});

async function runtimeWith(t: { after(fn: () => unknown): void }) {
	const fixture = await testHost({ facets: [tuiCoreFacet] });
	t.after(() => fixture.close());
	const terminal = new VirtualTerminal(100, 40);
	const tui = new TuiAltScreen(terminal);
	const runtime = new TuiRuntime(fixture.host, tui);
	const grants: [string, unknown][] = [];
	runtime.onGrant = async (action, payload) => {
		grants.push([action, payload]);
		return { ok: true };
	};
	await runtime.start();
	tui.setLayoutRoot(runtime.root);
	tui.setFocus(runtime);
	tui.start();
	t.after(() => {
		tui.stop();
		runtime.dispose();
	});
	await poll(() => runtime.commands.list().some((item) => item.slash === "settings"));
	const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
	return { runtime, grants, screen, send: (data: string) => terminal.sendInput(data) };
}

test("/settings collects changes and proposes one patch; the theme preview never touches the live theme", async (t) => {
	const { runtime, grants, screen, send } = await runtimeWith(t);
	runtime.appearance.update({ local: { keybindings: {}, settings: {}, themes: {}, theme: "dark", problems: [] } });
	const live = runtime.theme.current;
	runtime.ctx.commands.runSlash("/settings");
	await poll(async () => (await screen()).includes("Hide thinking"));
	// Theme: the picker previews "light" in its own pane; the runtime's theme stays.
	send("\r");
	await poll(async () => (await screen()).includes("Preview"));
	assert((await screen()).includes("→ ✓ dark"));
	send("\x1b[B");
	await poll(async () => /→ +light/.test(stripTerminalSequences(await screen())));
	assert.equal(runtime.theme.current, live, "the preview is isolated");
	send("\r");
	await poll(async () => (await screen()).includes("Hide thinking"));
	assert.equal(runtime.theme.current, live);
	// Hide thinking: true (p2's default) → false.
	send("\x1b[B");
	send("\r");
	assert.deepEqual(grants, [], "nothing is proposed while the list is open");
	send("\x1b");
	await poll(() => grants.length === 1);
	assert.deepEqual(grants[0], ["savePrefs", { patch: { settings: { hideThinkingBlock: false }, theme: "light" } }]);
});

test("hideThinkingBlock sets the thinking view; the toggle holds until the setting changes and across a reload", async (t) => {
	const { runtime } = await runtimeWith(t);
	const local = (settings: { hideThinkingBlock?: boolean }) => ({
		keybindings: {},
		settings,
		themes: {},
		problems: [],
	});
	assert.equal(runtime.showThinking, false, "unset: hidden");
	runtime.appearance.update({ local: local({ hideThinkingBlock: false }) });
	assert.equal(runtime.showThinking, true);
	runtime.ctx.view.showThinking = false;
	runtime.appearance.update({ local: local({ hideThinkingBlock: false }) });
	assert.equal(runtime.showThinking, false, "an unchanged setting keeps the toggle");
	const next = new TuiRuntime(runtime.host, runtime.tui);
	t.after(() => next.dispose());
	restoreRuntime(next, JSON.parse(JSON.stringify(snapshotRuntime(runtime))));
	next.appearance.update({ local: local({ hideThinkingBlock: false }) });
	assert.equal(next.showThinking, false, "a reload keeps the toggle");
	runtime.appearance.update({ local: local({}) });
	assert.equal(runtime.showThinking, false);
	runtime.ctx.view.showThinking = true;
	runtime.appearance.update({ local: local({ hideThinkingBlock: false }) });
	runtime.appearance.update({ local: local({ hideThinkingBlock: true }) });
	assert.equal(runtime.showThinking, false, "a changed setting wins over the toggle");
});

test("/keybindings rebinds through savePrefs; launcher-owned keys are listed but not editable", async (t) => {
	const { runtime, grants, screen, send } = await runtimeWith(t);
	runtime.ctx.commands.runSlash("/keybindings");
	await poll(async () => (await screen()).includes("Keybindings"));
	for (const char of "command palette") send(char);
	await poll(async () => (await screen()).includes("Command palette"));
	send("\r");
	await poll(async () => (await screen()).includes("Press the new key"));
	send("\x0b");
	await poll(() => grants.length === 1);
	assert.deepEqual(grants[0], ["savePrefs", { patch: { keybindings: { "p2.palette": "ctrl+k" } } }]);
	runtime.closeOverlays();
	runtime.ctx.commands.runSlash("/keybindings");
	await poll(async () => (await screen()).includes("Keybindings"));
	for (const char of "external editor") send(char);
	await poll(async () => (await screen()).includes("launcher-owned"));
	send("\r");
	await poll(() => runtime.notices.some((notice) => notice.text.includes("Launcher-owned")));
	assert.equal(grants.length, 1);
});

test(
	"end to end: the launcher shows the diff, writes prefs.json, and the watcher applies the new theme",
	{ skip: !supported, timeout: 60000 },
	async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		await (await holdIn(fixture.browser(), Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const directory = mkdtempSync(join(tmpdir(), "p2-prefs-e2e-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const sources = { agentDir: join(directory, "agent"), configDir: join(directory, "p2-tui") };
		const current = loadLocalPreferences(sources);
		const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
		const terminal = new VirtualTerminal(100, 40);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = (data) => {
			writes.push(data);
			write(data);
		};
		const client = await startTuiClient({
			terminal,
			url,
			pollMs: 60000,
			colorQueryMs: 10,
			capabilities: { trueColor: true, platform: "linux", windowsKeys: false },
			preferences: { current, subscribe: (listener) => watchLocalPreferences(sources, listener, current) },
			actions: launcherActions({ url, credentials: {}, role: "owner", prefsDirectory: sources.configDir }),
		});
		t.after(() => client.close());
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		await poll(async () => (await screen()).includes("New session"), 15000);
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await poll(async () => !(await screen()).includes("Connecting conversation") && (await screen()).includes("•"));
		for (const char of "/settings") terminal.sendInput(char);
		terminal.sendInput("\r");
		await poll(async () => (await screen()).includes("Hide thinking"));
		// Theme → light (system, dark, light), then Hide thinking off, then Esc proposes both.
		terminal.sendInput("\r");
		await poll(async () => (await screen()).includes("Preview"));
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await poll(async () => (await screen()).includes("Hide thinking"));
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		terminal.sendInput("\x1b");
		await poll(async () => (await screen()).includes("Save your TUI preferences on this computer"));
		assert((await screen()).includes("+ settings.hideThinkingBlock: false"));
		assert((await screen()).includes('+ theme: "light"'));
		// The light theme's muted color (the live system theme uses the terminal's palette indices instead).
		const muted = createTheme(LIGHT_THEME, "truecolor").getFgAnsi("muted");
		writes.length = 0;
		terminal.sendInput("y");
		await poll(() => {
			try {
				return JSON.parse(readFileSync(join(sources.configDir, "prefs.json"), "utf8")).theme === "light";
			} catch {
				return false;
			}
		});
		// The launcher's watcher posts the saved file; the worker repaints in the light theme.
		await poll(() => writes.join("").includes(muted), 10000, "light theme applied");
		await poll(async () => (await screen()).includes("Preferences saved"));
	},
);
