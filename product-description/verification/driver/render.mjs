// Render a recorded pty byte stream through xterm headless and print the screen.
// Usage: node render.mjs <file.bin> [cols] [rows] [--scrollback]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const xterm = require("./node_modules/@xterm/headless/lib-headless/xterm-headless.js");

const [file, colsArg, rowsArg, ...flags] = process.argv.slice(2);
const cols = Number(colsArg || 100);
const rows = Number(rowsArg || 40);
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
const data = readFileSync(file);
await new Promise((resolve) => term.write(data, resolve));
const buf = term.buffer.active;
const start = flags.includes("--scrollback") ? 0 : buf.viewportY;
const lines = [];
for (let y = start; y < buf.length; y++) {
	const line = buf.getLine(y);
	lines.push(line ? line.translateToString(true) : "");
}
// Trim trailing blank lines
while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
console.log(lines.join("\n"));
console.log(`--- cursor at row ${buf.cursorY} col ${buf.cursorX}; ${buf.length} buffer rows`);
