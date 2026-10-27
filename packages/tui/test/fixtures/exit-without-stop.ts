import { ProcessTerminal } from "../../src/terminal.ts";
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";

const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
tui.start();
if (process.argv[2] === "stop") tui.stop({ preserveScreen: true });
process.exit(0);
