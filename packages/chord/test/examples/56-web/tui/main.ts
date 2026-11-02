// The board app's terminal entry (the base bundle the sandbox runs): `startTerminalRuntime` with the app's terminal
// modules, a core facet serving `Lines`, and a redraw of the board on every change (`TuiScope`). `q` quits.

import * as chord from "../../../../src/index.ts";
import { startTerminalRuntime, TuiScope } from "../../../../src/tui/index.ts";
import * as v1tui from "../app/v1/tui.ts";
import * as v1 from "../app/v1.ts";

const core = chord.defineFacet((host) =>
	host.serve(v1tui.Lines, { compose: (table) => table.map(({ value }) => value) }),
);

void startTerminalRuntime({
	modules: { "@board/app/v1": v1, "@board/app/v1/tui": v1tui },
	core: [{ name: "@board/core", facet: core }],
	render: (runtime) => {
		const { terminal, theme } = runtime;
		const scope = new TuiScope(runtime.host, () => draw());
		const lines = scope.registry(v1tui.Lines);
		const draw = (): void => {
			const body = (lines() ?? []).map((line) => `  ${theme.fg("fg", line)}`).join("\r\n");
			terminal.write(`\x1b[2J\x1b[H${theme.fg("accent", "Board")}\r\n${body}\r\n`);
		};
		theme.onChange(draw);
		terminal.onInput((data) => {
			if (data === "q") runtime.exit(0);
		});
		draw();
	},
});
