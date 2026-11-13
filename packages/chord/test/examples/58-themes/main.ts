// Themes (slice 11 §4b, decision "Looks and themes"): a theme is data in the kit's `Themes` registry, contributed by a
// plugin (`plugins/solarized/`: the same theme for pages and terminals). The user picks one dark and one light theme
// (`ThemeChoice`, kept per principal on the server); a page writes the active one as CSS variables on `:root`, a
// terminal looks colours up by role. Editing the theme plugin restyles both live: no reload.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/58-themes/main.ts
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import * as chord from "../../../src/index.ts";
import { followActiveTheme, type Theme, ThemeChoice, themesFacet, themeVariables } from "../../../src/index.ts";
import { type RunningTerminal, requireSandboxNode, startTerminal } from "../../../src/node/tui/index.ts";
import { TerminalTheme } from "../../../src/tui/index.ts";
import type { BoardPrincipal } from "../56-web/app/principals.ts";
import * as v1web from "../56-web/app/v1/web.ts";
import * as v1 from "../56-web/app/v1.ts";
import { headlessPage } from "../56-web/headless.ts";
import { boardDirectories, startBoard } from "../56-web/start.ts";

// 1. The board with two theme plugins added to its plugins: Solarized (a directory) and Midnight (a single file).
const { base, dataDir, root } = await boardDirectories();
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });
const app = await startBoard(dataDir, root, context);
const token = (await readFile(app.ownerTokenFile, "utf8")).trim();

// 2. A page (headless here; `startPage` does the same with the kit's themes facet) and the theme it would write.
const core = [
	{ name: "chord.themes", facet: themesFacet<BoardPrincipal>() },
	{
		name: "@board/core",
		facet: chord.defineFacet<BoardPrincipal>((host) =>
			host.serve(v1web.Panels, { compose: (table) => table.map(({ value }) => value) }),
		),
	},
];
const page = await headlessPage(
	new URL(app.ownerLink()).origin,
	token,
	{ "@board/app/v1": v1, "@board/app/v1/web": v1web },
	core,
);
let active: Theme | undefined;
await followActiveTheme(
	page.host,
	"dark",
	(theme) => {
		active = theme;
	},
	context,
);
const show = (step: string): void => {
	const variables = themeVariables(active!);
	console.log(
		`${step} ${active!.name}: --accent ${variables["--accent"]}, --bg ${variables["--bg"]}, --radius ${variables["--radius"] ?? "-"}`,
	);
	const terminal = new TerminalTheme(active!, "256");
	console.log(
		`   terminal (256 colours): ${JSON.stringify(terminal.fg("accent", "Board"))} ${JSON.stringify(terminal.fg("muted", "muted"))}`,
	);
};
while (active?.id !== "solarized-dark") await new Promise((resolve) => setTimeout(resolve, 10));
show("1. active (the first dark theme by plugin name):");

// 3. The user picks Midnight, then Solarized again: every page and terminal of theirs follows.
const choice = await page.host.get(ThemeChoice, {}, context);
const becomes = async (id: string): Promise<void> => {
	while (active?.id !== id) await new Promise((resolve) => setTimeout(resolve, 10));
};
await choice.choose({ dark: "midnight", light: null }, context);
await becomes("midnight");
show("2. picked:");
await choice.choose({ dark: "solarized-dark", light: null }, context);
await becomes("solarized-dark");

// 4. A terminal client, when this Node can sandbox it: its frames are drawn in the same theme (true colour here).
const frames: string[] = [];
let terminal: RunningTerminal | undefined;
if (sandboxAvailable()) {
	const output = Object.assign(new PassThrough(), { columns: 60, rows: 10 });
	output.on("data", (chunk: Buffer) => frames.push(chunk.toString()));
	const credentials = { kind: "file", path: app.ownerTokenFile } as const;
	terminal = await startTerminal({
		url: new URL(app.ownerLink()).origin,
		credentials,
		input: new PassThrough(),
		output,
		colors: "truecolor",
	});
	while (!frames.join("").includes("\x1b[38;2;181;137;0mBoard"))
		await new Promise((resolve) => setTimeout(resolve, 10));
	console.log("3. the terminal draws the title in Solarized's accent:", JSON.stringify("\x1b[38;2;181;137;0mBoard"));
} else console.log("3. (a terminal client needs Node 26.5.1 or later: see example 57)");

// 5. Edit the theme plugin and apply: the page's variables change in place, and the terminal redraws.
const file = join(root, "solarized", "theme.ts");
await writeFile(file, (await readFile(file, "utf8")).replace("#b58900", "#d33682"));
while (!app.plugins.state.value.dirty.includes("@board/solarized"))
	await new Promise((resolve) => setTimeout(resolve, 10));
await app.applyChanges(context);
while (active?.colors.accent !== "#d33682") await new Promise((resolve) => setTimeout(resolve, 10));
show("4. after the edit:");
if (terminal !== undefined) {
	while (!frames.join("").includes("\x1b[38;2;211;54;130mBoard"))
		await new Promise((resolve) => setTimeout(resolve, 10));
	console.log("   the terminal redrew in the new accent:", JSON.stringify("\x1b[38;2;211;54;130mBoard"));
	await terminal.stop();
}

choice.release();
await page.stop(context);
await app.close(context);
await rm(base, { recursive: true, force: true });

/** Whether this Node can run the terminal's sandbox. */
function sandboxAvailable(): boolean {
	try {
		requireSandboxNode();
		return true;
	} catch {
		return false;
	}
}
