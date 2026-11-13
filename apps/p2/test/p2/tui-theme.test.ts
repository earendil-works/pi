import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Markdown, TuiAltScreen } from "@earendil-works/pi-tui";
import { WebSocketServer } from "ws";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { loadLocalPreferences, watchLocalPreferences } from "../../src/hosts/tui-local-preferences.ts";
import { colorFgBgScheme, parseOscColor, TerminalColorProbe } from "../../src/hosts/tui-terminal-colors.ts";
import { TuiRuntime } from "../../src/runtime/tui.ts";
import {
	effectivePreferences,
	sanitizeServerPreferences,
	type TuiLocalPreferences,
} from "../../src/tui/preferences.ts";
import { DARK_THEME, LIGHT_THEME } from "../../src/tui/theme/builtin-themes.ts";
import { ThemeRef } from "../../src/tui/theme/ref.ts";
import { createSystemTheme, createTheme, resolveTheme, type TerminalState } from "../../src/tui/theme/theme.ts";
import { poll, testHost } from "./helpers.ts";

const local = (patch: Partial<TuiLocalPreferences>): TuiLocalPreferences => ({
	keybindings: {},
	settings: {},
	themes: {},
	problems: [],
	...patch,
});
async function runtime(t: { after(fn: () => unknown): void }) {
	const fixture = await testHost({ facets: [] });
	t.after(() => fixture.close());
	const value = new TuiRuntime(fixture.host, new TuiAltScreen(new VirtualTerminal(60, 20)));
	t.after(() => value.dispose());
	return value;
}
const heading = (ref: ThemeRef) => new Markdown("# Title", 0, 0, ref.markdown).render(40).join("\n");

test("two runtimes in one process keep their own themes, previews and terminal colors", async (t) => {
	const dark = await runtime(t);
	const light = await runtime(t);
	dark.appearance.update({ local: local({ theme: "dark" }) });
	light.appearance.update({ local: local({ theme: "light" }) });
	assert.equal(dark.theme.current.name, "dark");
	assert.equal(light.theme.current.name, "light");
	assert.notEqual(heading(dark.theme), heading(light.theme), "different SGR per instance");

	// A rendered component built on the ref's derived theme picks up a swap without being rebuilt.
	const component = new Markdown("# Title", 0, 0, dark.theme.markdown);
	const before = component.render(40).join("\n");
	const version = dark.theme.version;
	dark.appearance.update({ local: local({ theme: "light" }) });
	assert.equal(dark.theme.version, version + 1);
	component.invalidate();
	assert.equal(component.render(40).join("\n"), heading(light.theme));
	assert.notEqual(component.render(40).join("\n"), before);
	// Unchanged inputs do not swap (no needless rebuilds).
	dark.appearance.update({ local: local({ theme: "light" }) });
	assert.equal(dark.theme.version, version + 1);

	// A picker preview uses its own ref; the live one is untouched.
	const preview = new ThemeRef(createTheme(DARK_THEME, "truecolor"));
	assert.notEqual(heading(preview), heading(dark.theme));
	assert.equal(dark.theme.current.name, "light");

	// Terminal colors reach only the instance they were given to (system theme follows them).
	dark.appearance.update({ local: local({}) });
	light.appearance.update({ local: local({}) });
	const untouched = light.theme.current.fg("accent", "x");
	dark.appearance.update({
		terminal: { colors: { background: { r: 250, g: 250, b: 250 }, foreground: { r: 10, g: 10, b: 10 } } },
	});
	assert.equal(dark.theme.current.appearance, "light");
	assert.equal(light.theme.current.appearance, "dark");
	assert.equal(light.theme.current.fg("accent", "x"), untouched);
});

test("theme resolution: pairs, color modes, custom data, invalid fallback, lowlight highlighting", () => {
	const terminal: TerminalState = { colors: {}, scheme: "light" };
	assert.equal(resolveTheme({ setting: "light/dark", mode: "256color", terminal }).theme.name, "light");
	assert.equal(resolveTheme({ setting: "light/dark", mode: "256color", terminal: { colors: {} } }).theme.name, "dark");
	const custom = { ...DARK_THEME, name: "mine", colors: { ...DARK_THEME.colors, accent: "#123456" } };
	const truecolor = resolveTheme({ setting: "mine", themes: { mine: custom }, mode: "truecolor", terminal });
	assert.match(truecolor.theme.fg("accent", "x"), /38;2;18;52;86/);
	assert.match(createTheme(custom, "256color").fg("accent", "x"), /38;5;\d+m/);
	const broken = resolveTheme({
		setting: "bad",
		themes: { bad: { ...DARK_THEME, name: "bad", colors: { ...DARK_THEME.colors, accent: "nope" } } },
		mode: "256color",
		terminal,
	});
	assert.equal(broken.theme.name, "system");
	assert.match(broken.error ?? "", /nope|Variable/);
	assert.equal(resolveTheme({ setting: "missing", mode: "256color", terminal }).error, "Theme not found: missing");
	const theme = createTheme(LIGHT_THEME, "truecolor");
	const lines = theme.highlight("const x = 'a';\n// note", "ts");
	assert.equal(lines.length, 2);
	assert(lines[0]!.includes(theme.getFgAnsi("syntaxKeyword")));
	assert(lines[1]!.includes(theme.getFgAnsi("syntaxComment")));
	assert.deepEqual(theme.highlight("plain", "nonexistent-language"), [theme.fg("mdCodeBlock", "plain")]);
	assert.equal(theme.bold("b"), "\x1b[1mb\x1b[22m");
	assert.equal(createSystemTheme("256color", { colors: {}, pending: true }).name, "system");
});

test("server defaults: whitelisted, no privileged bindings, below the visitor's local preferences", () => {
	const server = sanitizeServerPreferences({
		keybindings: { "app.clipboard.pasteImage": "ctrl+y", "app.model.select": "ctrl+k", "app.tools.expand": "ctrl+e" },
		theme: { accent: 35 },
		settings: { hideThinkingBlock: true, editorPaddingX: 9, externalEditor: "vim", terminal: { showImages: false } },
	});
	assert.deepEqual(server, {
		keybindings: { "app.model.select": "ctrl+k", "app.tools.expand": "ctrl+e" },
		settings: { hideThinkingBlock: true, terminal: { showImages: false } },
	});
	const effective = effectivePreferences(
		{ ...server, theme: "light", keybindings: { ...server.keybindings, "app.suspend": "ctrl+q" } },
		local({ keybindings: { "app.model.select": "ctrl+j" }, settings: { terminal: { imageWidthCells: 40 } } }),
	);
	assert.deepEqual(effective.keybindings, { "app.model.select": "ctrl+j", "app.tools.expand": "ctrl+e" });
	assert.equal(effective.theme, "light");
	assert.deepEqual(effective.settings, {
		hideThinkingBlock: true,
		terminal: { showImages: false, imageWidthCells: 40 },
	});
});

test("launcher reads pi's files and p2 prefs, validates themes and hot-reloads custom themes", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-tui-prefs-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const agentDir = join(directory, "agent");
	const configDir = join(directory, "p2-tui");
	mkdirSync(join(agentDir, "themes"), { recursive: true });
	mkdirSync(configDir);
	const theme = (accent: string) =>
		JSON.stringify({ ...DARK_THEME, name: "mine", colors: { ...DARK_THEME.colors, accent } });
	writeFileSync(join(agentDir, "themes", "mine.json"), theme("#123456"));
	writeFileSync(join(agentDir, "themes", "broken.json"), JSON.stringify({ name: "broken", colors: {} }));
	writeFileSync(join(agentDir, "themes", "dark.json"), JSON.stringify({ ...DARK_THEME }));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			theme: "dark",
			defaultModel: "secret-ish",
			markdown: { codeBlockIndent: "    " },
			quietStartup: 3,
		}),
	);
	writeFileSync(join(configDir, "prefs.json"), JSON.stringify({ theme: "mine", settings: { quietStartup: true } }));
	const sources = { agentDir, configDir };
	const loaded = loadLocalPreferences(sources);
	assert.equal(loaded.theme, "mine");
	assert.deepEqual(Object.keys(loaded.themes), ["mine"]);
	assert.deepEqual(loaded.settings, { markdown: { codeBlockIndent: "    " }, quietStartup: true });
	assert(loaded.problems.some((problem) => problem.startsWith("themes/broken.json: Invalid theme")));
	assert(loaded.problems.includes('themes/dark.json: theme name "dark" is reserved or invalid'));
	assert(loaded.problems.includes("settings.json: invalid quietStartup"));
	assert(!JSON.stringify(loaded).includes(directory), "no local paths reach the worker");
	assert(!JSON.stringify(loaded).includes("secret-ish"), "only whitelisted settings");
	assert.equal(loadLocalPreferences({ ...sources, theme: "light", noThemes: true }).theme, "light");
	assert.deepEqual(loadLocalPreferences({ ...sources, noThemes: true }).themes, {});

	const updates: TuiLocalPreferences[] = [];
	const stop = watchLocalPreferences(sources, (next) => updates.push(next), loaded);
	t.after(stop);
	writeFileSync(join(agentDir, "themes", "mine.json"), theme("#654321"));
	await poll(() => updates.some((next) => JSON.stringify(next.themes.mine?.colors).includes("#654321")), 5000);
	const view = await runtime(t);
	view.appearance.update({ local: loaded, capabilities: { trueColor: true, platform: "linux", windowsKeys: false } });
	assert.match(view.theme.current.fg("accent", "x"), /38;2;18;52;86/);
	view.appearance.update({ local: updates.at(-1)! });
	assert.match(view.theme.current.fg("accent", "x"), /38;2;101;67;33/);
});

test("terminal color probe consumes replies, never forwards them, and tracks scheme reports", () => {
	const written: string[] = [];
	const states: TerminalState[] = [];
	const probe = new TerminalColorProbe({
		write: (data) => written.push(data),
		onUpdate: (state) => states.push(state),
	});
	probe.start();
	assert(written.join("").startsWith("\x1b[?2031h\x1b]10;?\x07"));
	assert(probe.consume("\x1b]11;rgb:ffff/ffff/ffff\x07"));
	assert(probe.consume("\x1b]10;#000000\x1b\\"));
	assert(!probe.consume("a"));
	assert(probe.consume("\x1b[?62;22c"));
	assert.deepEqual(states.at(-1)?.colors, {
		background: { r: 255, g: 255, b: 255 },
		foreground: { r: 0, g: 0, b: 0 },
	});
	assert(probe.consume("\x1b[?997;2n"));
	assert.equal(probe.state.scheme, "light");
	probe.stop();
	assert(written.at(-1)?.includes("\x1b[?2031l"));
	assert.deepEqual(parseOscColor("rgb:80/80/80"), { r: 128, g: 128, b: 128 });
	assert.equal(parseOscColor("bogus"), undefined);
	assert.equal(colorFgBgScheme({ COLORFGBG: "15;0" }), "dark");
	assert.equal(colorFgBgScheme({ COLORFGBG: "0;15" }), "light");
});

test(
	"launcher posts capabilities, preferences and terminal colors as data before activation and on change",
	{ skip: Number(process.versions.node.split(".")[0]) < 26, timeout: 15000 },
	async (t) => {
		const source = `const seen=[];export default ({onMessage})=>onMessage(message=>{
			if(message.kind==='snapshot')return seen;
			if(message.kind!=='resize')seen.push({kind:message.kind,preferences:message.preferences,platform:message.platform,terminal:message.terminal});
		});`;
		const version = createHash("sha256").update(source).digest("hex");
		const server = createServer((request, response) => {
			response.setHeader("Content-Type", request.url === "/__p2_tui" ? "application/json" : "text/javascript");
			response.end(
				request.url === "/__p2_tui" ? JSON.stringify({ version, bundle: `/__p2_tui/${version}.mjs` }) : source,
			);
		});
		const sockets = new WebSocketServer({ server });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert(address && typeof address === "object");
		t.after(async () => {
			for (const socket of sockets.clients) socket.terminate();
			await new Promise<void>((resolve) => sockets.close(() => resolve()));
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		let notify: ((next: TuiLocalPreferences) => void) | undefined;
		const terminal = new VirtualTerminal();
		const client = await startTuiClient({
			terminal,
			url: new URL(`http://127.0.0.1:${address.port}`),
			pollMs: 60000,
			colorQueryMs: 10,
			capabilities: { trueColor: false, platform: "darwin", windowsKeys: false },
			preferences: {
				current: local({ theme: "light" }),
				subscribe: (listener) => {
					notify = listener;
					return () => {};
				},
			},
		});
		t.after(() => client.close());
		type Seen = { kind: string; preferences?: TuiLocalPreferences; platform?: string; terminal?: TerminalState }[];
		const seen = async () => (await client.snapshot()) as Seen;
		assert.deepEqual(
			(await seen()).slice(0, 3).map((item) => item.kind),
			["capabilities", "preferences", "activate"],
		);
		assert.equal((await seen())[0]?.platform, "darwin");
		await poll(async () => (await seen()).some((item) => item.kind === "terminalColors"));
		notify?.(local({ theme: "dark" }));
		await poll(async () => (await seen()).at(-1)?.preferences?.theme === "dark");
		// Terminal replies to the launcher's query are consumed by the launcher, never forwarded.
		terminal.sendInput("\x1b]11;rgb:0000/0000/0000\x07");
		await poll(async () => {
			const last = (await seen()).at(-1);
			return last?.kind === "terminalColors" && last.terminal?.colors.background?.r === 0;
		});
		assert(!(await seen()).some((item) => item.kind === "input"));
	},
);
