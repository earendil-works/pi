// Worker lifecycle as in Pi Mobile: a root model no longer configured fails the start visibly; an exit nobody asked
// for is an owner notice ("Worker exited (signal): …") and its holders get a new worker (five crash restarts a
// minute; the next crash is the status error until Retry); the default thinking level comes from the settings when
// the default model is not listed.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { summarize } from "../../plugins/models/config.ts";
import type { Resources } from "../../plugins/models/resources.ts";
import { Catalog, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus, WorkerControl } from "../../plugins/status/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { envDefaultModel } from "../../src/runtime/default-model.ts";
import { processLogs } from "../../src/runtime/logs.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { type Fixture, failureOf, holdIn, startFixture, until } from "./helpers.ts";

describe("worker lifecycle (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let status: RefIn<typeof SessionStatus, "reader">;
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		status = await holdIn(owner, SessionStatus, {}, "reader");
	});
	after(async () => {
		await fixture?.close();
	});

	it("fails the start of a session whose model is no longer configured", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await fixture.server.host.root(
			async (ctx) =>
				(await ctx.get(Catalog, {})).update(
					{ id: session.id, model: { provider: "faux", modelId: "removed" } },
					ctx,
				),
			BACKGROUND_CONTEXT,
		);
		const chat = owner.hold(Chat, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		// A failed start leaves its holders waiting (failed until Retry), with the start's error.
		assert.match((await failureOf(chat)).message, /Unknown model/);
		const statuses = await until(status.statuses, (value) => Boolean(value?.[session.id]?.error));
		assert.match(statuses?.[session.id]?.error ?? "", /Unknown model/);
		chat.release();
	});

	it("records an unrequested exit as a notice and restarts the worker for its holders", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const source = `session:${session.id}`;
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "hello", requestId: "one" }, BACKGROUND_CONTEXT);
		const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
		try {
			const workers = await until(hosts.workers, (value) => Boolean(value?.[session.id]?.pid));
			const pid = workers![session.id]!.pid!;
			process.kill(pid, "SIGKILL");
			// The signal, then the end of its stderr when it wrote any (Node 24's SQLite warning; Node 26 writes none).
			await until(hosts.workers, (value) => Boolean(value?.[session.id]?.running && value[session.id]?.pid !== pid));
			assert.ok(
				processLogs
					.notices()
					.some(
						(notice) => notice.source === source && /^Worker exited \(SIGKILL\)(: .+)?$/s.test(notice.message),
					),
			);
			// As in Pi Mobile the failure does not block: the held chat binds to a new worker.
			await until(chat.state, (state) => state.kind === "live");
			await chat.send({ text: "again", requestId: "two" }, BACKGROUND_CONTEXT);
		} finally {
			hosts.release();
			chat.release();
		}
	});

	it("restarts a crashed worker for its holders five times a minute; the sixth crash waits for Retry", async () => {
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
		const control = await holdIn(owner, WorkerControl, { session: session.id }, "owner");
		const running = async (other?: number) =>
			(await until(hosts.workers, (value) => {
				const worker = value?.[session.id];
				return Boolean(worker?.running && worker.pid && worker.pid !== other);
			}))![session.id]!.pid!;
		try {
			let pid = await running();
			// Held by `chat`: each crash restarts the worker without a new hold.
			for (let crash = 1; crash <= 5; crash++) {
				process.kill(pid, "SIGKILL");
				pid = await running(pid);
			}
			process.kill(pid, "SIGKILL");
			const failed = await until(status.statuses, (value) => Boolean(value?.[session.id]?.error));
			assert.match(failed?.[session.id]?.error ?? "", /^Worker exited \(SIGKILL\)/);
			// It stays failed: no start follows on its own.
			await assert.rejects(
				until(status.statuses, (value) => !value?.[session.id]?.error, 1_500),
				/timed out/,
			);
			// The owner's Retry starts it again, and clears the count.
			await control.restart(BACKGROUND_CONTEXT);
			pid = await running(pid);
			process.kill(pid, "SIGKILL");
			await running(pid);
		} finally {
			control.release();
			hosts.release();
			chat.release();
		}
	});
});

it("keeps the settings' thinking level when the default model is not listed", () => {
	const resources = {
		snapshot: () => ({
			credentials: [],
			models: [],
			settings: { defaultModel: { provider: "gone", modelId: "model" }, thinkingLevel: "low" },
			errors: [],
		}),
	} as unknown as Resources;
	assert.deepEqual(summarize(resources, false).defaultModel, {
		provider: "gone",
		modelId: "model",
		thinkingLevel: "low",
	});
});

it("takes the default model from P2_PROVIDER/P2_MODEL (or Pi Mobile's names) after settings.json's", async () => {
	assert.deepEqual(envDefaultModel({ P2_PROVIDER: "faux", P2_MODEL: "faux-1" }), {
		provider: "faux",
		modelId: "faux-1",
	});
	assert.deepEqual(envDefaultModel({ PI_MOBILE_PROVIDER: "a", PI_MOBILE_MODEL: "b" }), {
		provider: "a",
		modelId: "b",
	});
	assert.equal(envDefaultModel({}), undefined);
	assert.throws(() => envDefaultModel({ P2_PROVIDER: "faux" }), /Set both P2_PROVIDER and P2_MODEL/);
	const resources = (defaultModel?: { provider: string; modelId: string }) =>
		({
			snapshot: () => ({
				credentials: [],
				models: [
					{ provider: "faux", modelId: "faux-1", name: "Faux", thinkingLevels: ["off", "high"], contextWindow: 1 },
				],
				settings: { ...(defaultModel ? { defaultModel } : {}) },
				errors: [],
			}),
		}) as unknown as Resources;
	const saved = { provider: process.env.P2_PROVIDER, model: process.env.P2_MODEL };
	try {
		process.env.P2_PROVIDER = "env";
		process.env.P2_MODEL = "model";
		assert.equal(summarize(resources(), true).defaultModel?.provider, "env");
		assert.equal(summarize(resources({ provider: "faux", modelId: "faux-1" }), true).defaultModel?.provider, "faux");
		delete process.env.P2_MODEL;
		await assert.rejects(startServer({ port: 0, fake: true, web: false, dataDir: "/nonexistent-p2" }), /Set both/);
	} finally {
		for (const [key, value] of [
			["P2_PROVIDER", saved.provider],
			["P2_MODEL", saved.model],
		] as const)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
	assert.equal(summarize(resources(), true).defaultModel?.provider, "faux", "the first listed model otherwise");
});
