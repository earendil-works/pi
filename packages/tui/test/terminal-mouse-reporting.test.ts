import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

type RestoreFn = () => void;
const restores: RestoreFn[] = [];

afterEach(() => {
	while (restores.length > 0) {
		restores.pop()?.();
	}
});

function stubMethod<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]): void {
	const original = obj[key];
	obj[key] = value;
	restores.push(() => {
		obj[key] = original;
	});
}

function stubSetTimeout(): void {
	const original = globalThis.setTimeout;
	(globalThis as typeof globalThis & { setTimeout: typeof setTimeout }).setTimeout = ((
		_callback: (...args: any[]) => void,
		_delay?: number,
	) => ({}) as ReturnType<typeof setTimeout>) as typeof setTimeout;
	restores.push(() => {
		(globalThis as typeof globalThis & { setTimeout: typeof setTimeout }).setTimeout = original;
	});
}

describe("ProcessTerminal mouse reporting", () => {
	it("enables mouse reporting on start and disables it on stop", () => {
		const writes: string[] = [];
		const terminal = new ProcessTerminal();

		stubMethod(process.stdout, "write", ((data: string | Uint8Array) => {
			writes.push(String(data));
			return true;
		}) as typeof process.stdout.write);
		stubMethod(
			process.stdout,
			"on",
			((_event: string, _listener: (...args: any[]) => void) => process.stdout) as typeof process.stdout.on,
		);
		stubMethod(
			process.stdout,
			"removeListener",
			((_event: string, _listener: (...args: any[]) => void) =>
				process.stdout) as typeof process.stdout.removeListener,
		);
		stubMethod(process.stdin, "setRawMode", ((_raw: boolean) => {}) as typeof process.stdin.setRawMode);
		stubMethod(
			process.stdin,
			"setEncoding",
			((_encoding: BufferEncoding) => process.stdin) as typeof process.stdin.setEncoding,
		);
		stubMethod(process.stdin, "resume", (() => process.stdin) as typeof process.stdin.resume);
		stubMethod(process.stdin, "pause", (() => process.stdin) as typeof process.stdin.pause);
		stubMethod(
			process.stdin,
			"on",
			((_event: string, _listener: (...args: any[]) => void) => process.stdin) as typeof process.stdin.on,
		);
		stubMethod(
			process.stdin,
			"removeListener",
			((_event: string, _listener: (...args: any[]) => void) =>
				process.stdin) as typeof process.stdin.removeListener,
		);
		stubMethod(process, "kill", ((_pid: number, _signal?: NodeJS.Signals | number) => true) as typeof process.kill);
		stubSetTimeout();

		terminal.start(
			() => {},
			() => {},
		);
		terminal.stop();

		const output = writes.join("");
		assert.match(output, /\x1b\[\?2004h/);
		assert.match(output, /\x1b\[\?1000h\x1b\[\?1006h/);
		assert.match(output, /\x1b\[\?u/);
		assert.match(output, /\x1b\[\?2004l/);
		assert.match(output, /\x1b\[\?1000l\x1b\[\?1006l/);
	});
});
