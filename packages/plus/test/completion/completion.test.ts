/**
 * Tests for plus/src/completion — the `pipi completion <bash|zsh>` dispatcher
 * and the generated shell scripts.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BASH_COMPLETION } from "../../src/completion/bash.ts";
import { dispatchCompletion } from "../../src/completion/index.ts";
import { ZSH_COMPLETION } from "../../src/completion/zsh.ts";

function captureStdout(fn: () => void): string {
	let written = "";
	const origWrite = process.stdout.write;
	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		fn();
	} finally {
		process.stdout.write = origWrite;
	}
	return written;
}

describe("completion scripts", () => {
	it("cover hub commands, native pi commands, and global flags", () => {
		for (const script of [BASH_COMPLETION, ZSH_COMPLETION]) {
			assert.match(script, /profile/);
			assert.match(script, /completion/);
			assert.match(script, /install/);
			assert.match(script, /auth/);
			assert.match(script, /--as/);
			assert.match(script, /--thinking/);
		}
	});

	it("embed providers and thinking levels from the hub package", () => {
		for (const script of [BASH_COMPLETION, ZSH_COMPLETION]) {
			assert.match(script, /anthropic/);
			assert.match(script, /xhigh/);
		}
	});
});

describe("dispatchCompletion", () => {
	it("prints a script for bash and zsh", () => {
		for (const shell of ["bash", "zsh"]) {
			const out = captureStdout(() => dispatchCompletion([shell]));
			assert.match(out, /_pipi/);
			assert.ok(out.includes("complete -F") || out.includes("compdef"));
		}
	});

	it("rejects a missing or unsupported shell", () => {
		assert.throws(() => dispatchCompletion([]), /shell is required/);
		assert.throws(() => dispatchCompletion(["fish"]), /Unsupported shell/);
	});
});
