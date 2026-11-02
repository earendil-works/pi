// Test support for the terminal surface (slice 11 §4): a kit app with the terminal surface and the fixture's entry, a
// Node new enough for the sandbox (26.5.1 or later: `CHORD_TUI_NODE`, else `node26` on the `PATH`; the tests that need
// it are skipped without), and launchers run under it with their terminal on pipes or a pseudo-terminal.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { testApp } from "../app/support.ts";

/** The fixture's terminal entry and the launcher driver. */
const MAIN = fileURLToPath(new URL("../fixtures/tui/main.ts", import.meta.url));
const DRIVE = fileURLToPath(new URL("../fixtures/tui/drive.ts", import.meta.url));
const ESCAPES = fileURLToPath(new URL("../fixtures/tui/escapes.ts", import.meta.url));

/** A Node binary of 26.5.1 or later, or `undefined`. */
export const TUI_NODE = findNode();

function findNode(): string | undefined {
	for (const candidate of [process.env.CHORD_TUI_NODE, "node26"]) {
		if (candidate === undefined) continue;
		try {
			const version = execFileSync(candidate, ["--version"], { encoding: "utf8" }).trim().slice(1);
			const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
			if (major > 26 || (major === 26 && (minor > 5 || (minor === 5 && patch >= 1)))) return candidate;
		} catch {
			// Not there.
		}
	}
	return undefined;
}

/**
 * A terminal plugin contributing `Lines` the line `text`, how many of the sandbox's escapes it tried at its evaluation
 * (`escapes.ts`, copied into it) and the ones that got through (`escaped=none` when none did).
 */
export function linesPlugin(text: string): Record<string, string> {
	return {
		"escapes.ts": readFileSync(ESCAPES, "utf8"),
		"tui.ts": [
			'import { defineFacet } from "@test/app/v1";',
			'import { Lines } from "@test/app/v1/tui";',
			'import { escapes } from "./escapes.ts";',
			"const found = Object.entries(escapes());",
			'const escaped = found.filter(([, outcome]) => outcome === "ok").map(([name]) => name).join(", ") || "none";',
			`export default defineFacet((_host, self) => self.contribute(Lines, ${JSON.stringify(text)} + " tried=" + found.length + " escaped=" + escaped));`,
		].join("\n"),
	};
}

/** A kit app with the terminal surface and the lines plugin saying `text`. */
export function tuiApp(text = "plugin v1") {
	return testApp({
		kinds: { server: { platform: "node" }, worker: { platform: "node" }, tui: { platform: "node" } },
		plugins: { lines: linesPlugin(text) },
		tui: { entry: MAIN },
	});
}

/**
 * A launcher running under `TUI_NODE`, its terminal on pipes, or with `terminal: "pty"` a pseudo-terminal (`script`
 * from util-linux, which runs the command line through a shell: test arguments only, each quoted): what it printed, and
 * keys to send.
 */
export class Launched {
	readonly child: ChildProcess;
	output = "";
	readonly exited: Promise<number | null>;

	constructor(args: readonly string[], terminal: "pipes" | "pty" = "pipes") {
		const command = [TUI_NODE!, "--no-warnings", DRIVE, ...args];
		this.child =
			terminal === "pipes"
				? spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] })
				: spawn(
						"script",
						["-qefc", command.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" "), "/dev/null"],
						{
							stdio: ["pipe", "pipe", "pipe"],
						},
					);
		this.child.stdout!.on("data", (chunk: Buffer) => {
			this.output += chunk.toString();
		});
		this.child.stderr!.on("data", (chunk: Buffer) => {
			this.output += chunk.toString();
		});
		this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
	}

	/** Sends `keys` to the launcher's terminal. */
	type(keys: string): void {
		this.child.stdin!.write(keys);
	}

	/** Answers the prompt on screen with `key` once its keys count (the launcher ignores them for 300 ms). */
	async answer(key: string): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 350));
		this.type(key);
	}

	/** Waits until the output from offset `from` on matches `pattern` (20 s at most); the match. */
	async waitFor(pattern: RegExp, from = 0): Promise<RegExpMatchArray> {
		for (let index = 0; index < 400; index++) {
			const found = this.output.slice(from).match(pattern);
			if (found !== null) return found;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(this.output.slice(from)).toMatch(pattern);
		throw new Error("unreachable");
	}

	kill(): void {
		this.child.kill();
	}
}
