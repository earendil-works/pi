// Installing pi-env agent on a machine p2 reaches over SSH (plugins/envs/radius-machines.ts), with a stand-in for the
// daemon there and the fake Radius: what `install` gets, a second install re-enrolling the same machine, the
// installer's notes, and when the Envs sheet offers to use the machine through Radius.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Installed, installedReady, type RadiusMachine } from "../../plugins/envs/contract.ts";
import { installAgent, type RunDaemon } from "../../plugins/envs/radius-machines.ts";
import { ownerRadiusAccess } from "../../src/runtime/radius-client.ts";
import { writeRadiusConfig } from "../../src/runtime/radius-config.ts";
import { fakeRadius } from "./radius-fixture.ts";

/** A daemon that reports `status` and answers `install` as the agent does, recording each run. */
function daemon(status: object | undefined, install: object) {
	const runs: { args: readonly string[]; stdin?: string }[] = [];
	const run: RunDaemon = async (args, stdin) => {
		runs.push({ args, ...(stdin === undefined ? {} : { stdin }) });
		if (args[0] === "status") {
			if (status === undefined) throw new Error("usage: pi-env serve --token <hex>");
			return `${JSON.stringify(status)}\n`;
		}
		return `enrolled\n${JSON.stringify(install)}\n`;
	};
	return { run, runs };
}

test("installing the agent: a code on stdin, the installer's notes, a second install re-enrolls the machine", async (t) => {
	const radius = await fakeRadius({ channels: true });
	t.after(() => radius.close());
	const directory = await mkdtemp(join(tmpdir(), "p2-install-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeRadiusConfig(directory, {
		gateway: radius.gateway,
		serverId: randomUUID(),
		credential: { type: "oauth", access: "fixture-token", refresh: "unused", expires: Date.now() + 3_600_000 },
	});
	const access = ownerRadiusAccess(directory);
	const server = randomUUID();
	// A new machine (a daemon too old for `status` counts as one): an ordinary code.
	const first = daemon(undefined, {
		server_id: server,
		organization_id: "org_1",
		public_origin: "https://x.rdtun.com",
		service: "none",
		linger: null,
		notes: ["Start it now: nohup ~/.pi/env/bin/pi-env agent &"],
	});
	const installed = await installAgent(access, first.run, "gpu");
	assert.deepEqual(installed, {
		server,
		service: "none",
		linger: null,
		notes: ["Start it now: nohup ~/.pi/env/bin/pi-env agent &"],
	});
	assert.deepEqual(first.runs.at(-1), {
		args: ["install", "--gateway", radius.gateway, "--name", "gpu", "--code-stdin"],
		stdin: "CODE-1\n",
	});
	assert.deepEqual(radius.enrollments, [{ name: "gpu" }]);
	// Installed again (twice clicked, or later): the agent there is one of the owner's machines, so the code is bound to it.
	radius.addMachine(server, "gpu");
	const second = daemon(
		{ enrolled: true, gateway: `${radius.gateway}/`, serverId: server },
		{ server_id: server, service: "systemd-user", linger: true },
	);
	assert.deepEqual(await installAgent(access, second.run, "gpu"), {
		server,
		service: "systemd-user",
		linger: true,
		notes: [],
	});
	assert.deepEqual(radius.enrollments.at(-1), { name: "gpu", server_id: server });
	// Enrolled with another Radius, or as a machine the owner no longer has: an ordinary code.
	for (const status of [
		{ enrolled: true, gateway: "https://elsewhere.example", serverId: server },
		{ enrolled: true, gateway: radius.gateway, serverId: randomUUID() },
	]) {
		await installAgent(access, daemon(status, { server_id: server, service: "launchd" }).run, "gpu");
		assert.deepEqual(radius.enrollments.at(-1), { name: "gpu" });
	}
	await assert.rejects(
		installAgent(access, daemon(undefined, { service: "none" }).run, "gpu"),
		/Unexpected answer from pi-env install/,
	);
});

test("a machine is offered for use at once only when its agent keeps running; else once Radius lists it online", () => {
	const machine = (status: RadiusMachine["status"]): RadiusMachine => ({
		server: "s1",
		status,
		lastSeenAt: new Date(0).toISOString(),
	});
	const installed = (service: string, linger: boolean | null): Installed => ({
		server: "s1",
		service,
		linger,
		notes: [],
	});
	assert.equal(installedReady(installed("launchd", null), undefined), true);
	assert.equal(installedReady(installed("systemd-user", true), undefined), true);
	for (const waiting of [installed("none", null), installed("systemd-user", false)]) {
		assert.equal(installedReady(waiting, undefined), false);
		assert.equal(installedReady(waiting, [machine("offline")]), false);
		assert.equal(installedReady(waiting, [{ ...machine("online"), server: "s2" }]), false);
		assert.equal(installedReady(waiting, [machine("online")]), true);
	}
});
