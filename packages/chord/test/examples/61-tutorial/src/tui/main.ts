// The todo app's terminal entry, the base bundle the launcher's sandbox runs: `startTerminalRuntime` with the app's
// terminal modules, a core facet serving the `Screens` registry, and a redraw on every change. The screens are opened in
// a scope of their own, opened again when a reload changes them; `q` quits.

import * as v1 from "@todo/app/v1";
import * as v1tui from "@todo/app/v1/tui";
import { defineFacet } from "../../../../../src/index.ts";
import { startTerminalRuntime, TuiScope } from "../../../../../src/tui/index.ts";

/** The terminal's own facet: it serves `Screens`, composing the contributions in plugin-name order. */
const core = defineFacet((host) => host.serve(v1tui.Screens, { compose: (table) => table.map(({ value }) => value) }));

void startTerminalRuntime({
	modules: { "@todo/app/v1": v1, "@todo/app/v1/tui": v1tui },
	core: [{ name: "@todo/tui", facet: core }],
	render: (runtime) => {
		const { terminal, theme } = runtime;
		const screens = new TuiScope(runtime.host, () => draw()).registry(v1tui.Screens);
		let opened: { screens: readonly v1tui.Screen[]; scope: TuiScope; lines: (() => readonly string[])[] } | undefined;
		const draw = (): void => {
			const current = screens() ?? [];
			if (opened?.screens !== current) {
				opened?.scope.dispose();
				const scope = new TuiScope(runtime.host, () => draw());
				opened = { screens: current, scope, lines: current.map((screen) => screen.open(scope, theme)) };
			}
			const lines = opened.lines.flatMap((read) => read());
			terminal.write(`\x1b[2J\x1b[H${lines.join("\r\n")}\r\n`);
		};
		theme.onChange(draw);
		terminal.onInput((data) => {
			if (data === "q") runtime.exit(0);
		});
		draw();
	},
});
