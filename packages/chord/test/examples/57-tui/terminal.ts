// A terminal client of the board (slice 11 §4), interactive: the launcher in this process (Node 26.5.1 or later), the
// board's terminal code in its sandbox, this terminal its terminal. `q` quits.
// Run from packages/chord, with the board running (`57-tui/main.ts --serve` prints the URL and the token file):
//   node26 --conditions=source test/examples/57-tui/terminal.ts <url> <token file>
import { startTerminal } from "../../../src/node/tui/index.ts";

const [url, tokenFile] = process.argv.slice(2);
const terminal = await startTerminal({ url: url!, credentials: { kind: "file", path: tokenFile! } });
process.exitCode = await terminal.exited;
process.stdin.destroy();
