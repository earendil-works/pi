// A real LaunchAgent install and uninstall of `pi-env agent` on macOS, against the fake Radius. It loads a job with a
// label of its own into the user's launchd domain, so it runs only when PI_ENV_TEST_LAUNCHD=1; HOME points at a
// temporary directory, so the plist lands there and nothing of the real LaunchAgents changes.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { daemon } from "./daemon.ts";
import { FakeRelay } from "./fixtures/agent-relay.ts";

const label = `dev.pi.env.test-${process.pid}`;
const home = mkdtempSync(join(tmpdir(), "pi-env-launchd-"));
const state = join(home, "state");
const uid = process.getuid?.() ?? 0;

afterAll(() => {
	for (const domain of [`gui/${uid}`, `user/${uid}`]) {
		try {
			execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
		} catch {}
	}
	rmSync(home, { recursive: true, force: true });
});

function cli(args: string[], input = ""): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(daemon, args, { env: { ...process.env, HOME: home } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
		child.stdin.end(input);
	});
}

function lastJson(stdout: string): Record<string, unknown> {
	const lines = stdout.trim().split("\n");
	return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
}

describe.runIf(process.platform === "darwin" && process.env.PI_ENV_TEST_LAUNCHD === "1")(
	"pi-env install (launchd)",
	() => {
		it("installs a LaunchAgent that connects, and uninstalls it", async () => {
			const relay = await new FakeRelay().start();
			try {
				const connected = relay.waitForHost();
				const installed = await cli(
					["install", "--gateway", relay.url, "--code-stdin", "--state", state, "--service-name", label],
					relay.code(),
				);
				expect(installed.code, installed.stderr).toBe(0);
				expect(lastJson(installed.stdout)).toMatchObject({ server_id: relay.serverId, service: "launchd" });
				const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);
				expect(existsSync(plist)).toBe(true);
				const host = await connected;
				const status = lastJson((await cli(["status", "--state", state])).stdout);
				expect(status.service).toEqual({ kind: "launchd", name: label, state: "running" });
				const uninstalled = await cli(["uninstall", "--state", state]);
				expect(uninstalled.code, uninstalled.stderr).toBe(0);
				expect((await host.closed).code).toBeGreaterThan(0);
				expect(existsSync(plist)).toBe(false);
				expect(existsSync(state)).toBe(false);
				expect(() => execFileSync("launchctl", ["print", `gui/${uid}/${label}`], { stdio: "ignore" })).toThrow();
			} finally {
				relay.close();
			}
		}, 60_000);
	},
);
