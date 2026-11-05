// Relocation must fence admission at an actual idle boundary, not trust delayed status reports.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, follow, liveIn, statusOf, whenLive, withAbortSignal } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { PromptResources } from "../../plugins/prompt/contract.ts";
import { Catalog, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { Workspace } from "../../plugins/workspace/contract.ts";
import { expectVariant } from "../../src/runtime/chord.ts";
import { Hosts, type RelocationSteps, ServerNatives } from "../../src/runtime/server.ts";
import { WorkerBoundary } from "../../src/runtime/worker.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

const text = (view: ConversationView | null | undefined) =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		)
		.join("\n");
/** Output of every bash tool result, in order. */
const bashResults = (view: ConversationView | null | undefined) =>
	(view?.entries ?? [])
		.flatMap((entry) => entry.model ?? [])
		.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "bash")
		.map((message) => message.content.map((part) => (part.type === "text" ? part.text.trim() : "")).join());

describe("session relocation (fake provider)", () => {
	let fixture: Fixture;
	let target: string;
	before(async () => {
		fixture = await startFixture();
		target = join(fixture.workspace, "destination");
		mkdirSync(target);
	});
	after(async () => {
		await fixture?.close();
	});
	/** The session's running worker: its generation (a restart makes a new one). */
	const worker = (session: string) =>
		fixture.server.host.root(async (ctx) => {
			const hosts = await ctx.get(Hosts, {});
			const state = hosts.workers.value?.[session];
			return { running: state?.running, generation: state?.generation, pid: state?.pid, error: state?.error };
		}, BACKGROUND_CONTEXT);
	it("relocates a cold session without starting a worker and validates directories", async () => {
		const owner = fixture.browser(),
			sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		await sessions.relocate({ id: session.id, cwd: target, env: null }, BACKGROUND_CONTEXT);
		const rows = await until(sessions.sessions, (rows) => rows?.find((row) => row.id === session.id)?.cwd === target);
		assert.equal(rows?.find((row) => row.id === session.id)?.env, null);
		await fixture.server.host.root(async (ctx) => {
			const hosts = await ctx.get(Hosts, {});
			assert.equal(hosts.workers.value?.[session.id]?.running, undefined);
		}, BACKGROUND_CONTEXT);
		const file = join(target, "file.txt");
		writeFileSync(file, "not a directory");
		await assert.rejects(
			sessions.relocate({ id: session.id, cwd: file, env: null }, BACKGROUND_CONTEXT),
			/Working directory is not a directory/,
		);
		await assert.rejects(
			sessions.relocate({ id: session.id, cwd: target, env: "missing" }, BACKGROUND_CONTEXT),
			/not configured/,
		);
	});
	it("moves a viewed idle worker in place: references stay live, tools, prompt and workspace follow", async () => {
		const owner = fixture.browser(),
			sessions = await holdIn(owner, Sessions, {}, "owner"),
			status = await holdIn(owner, SessionStatus, {}, "reader");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		// A project template that exists only at the destination: the prompt resources load from the new cwd.
		mkdirSync(join(target, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(target, ".pi", "prompts", "moved.md"), "Moved here: $@");
		writeFileSync(join(target, "only-at-destination.txt"), "x");
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const prompts = owner.hold(PromptResources, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		const workspace = owner.hold(Workspace, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		await chat.send({ text: "before move", requestId: "before" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => text(view).includes("Echo: before move"));
		await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		const names = async () => {
			const result = await workspace.query({ kind: "list", path: "" }, BACKGROUND_CONTEXT);
			assert(result.kind === "list");
			return result.entries.map((entry) => entry.name);
		};
		assert(!(await names()).includes("only-at-destination.txt"));
		await until(prompts.templates, (templates) => templates !== undefined);
		assert(!prompts.templates.value?.some((template) => template.name === "moved"));
		const generation = await worker(session.id);
		const changes = workspace.changes.value ?? 0;

		await sessions.relocate({ id: session.id, cwd: target, env: null }, BACKGROUND_CONTEXT);
		// The same handles: nothing went gone, and the worker was not restarted.
		const view = await until(chat.view, (view) => (view?.docs["pi.agent"] as { cwd?: string })?.cwd === target);
		assert(text(view).includes("Echo: before move"));
		assert.equal(statusOf(chat), "live");
		assert.deepEqual(await worker(session.id), generation);
		await until(prompts.templates, (templates) => Boolean(templates?.some((template) => template.name === "moved")));
		await until(workspace.changes, (value) => (value ?? 0) > changes);
		assert((await names()).includes("only-at-destination.txt"));
		await chat.send({ text: "bash", requestId: "after" }, BACKGROUND_CONTEXT);
		const settled = await until(chat.view, (view) => bashResults(view).length === 1);
		assert.equal(bashResults(settled)[0], target);
		for (const ref of [chat, prompts, workspace]) ref.release();
	});
	// Pi Mobile 24e3fccdd: subagents that followed the session move with it; one spawned with its own location stays,
	// with its prompt resources.
	it("moves following subagents with the session, not one with its own location", async () => {
		const owner = fixture.browser(),
			sessions = await holdIn(owner, Sessions, {}, "owner"),
			status = await holdIn(owner, SessionStatus, {}, "reader"),
			agents = await holdIn(owner, Subagents, {}, "reader");
		const start = join(fixture.workspace, "start");
		const own = join(fixture.workspace, "own");
		const next = join(fixture.workspace, "next");
		for (const directory of [start, own, next]) mkdirSync(directory);
		// A template only in the subagent's own directory, one only at the session's destination.
		for (const [directory, name] of [
			[own, "mine"],
			[next, "theirs"],
		] as const) {
			mkdirSync(join(directory, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(directory, ".pi", "prompts", `${name}.md`), `${name}: $@`);
		}
		const session = await sessions.create({ cwd: start }, BACKGROUND_CONTEXT);
		const root = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const subagent = async (args: object, requestId: string) => {
			await root.send({ text: `subagent ${JSON.stringify(args)}`, requestId }, BACKGROUND_CONTEXT);
			await until(root.view, (view) => text(view).includes(`Echo: subagent ${JSON.stringify(args)}`));
			await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		};
		await subagent({ action: "spawn", name: "follow", message: "hi", tools: ["bash"] }, "follow");
		await subagent({ action: "spawn", name: "own", message: "hi", cwd: own, tools: ["bash"] }, "own");
		await sessions.relocate({ id: session.id, cwd: next, env: null }, BACKGROUND_CONTEXT);
		root.release();
		const current = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await until(current.view, (view) => (view?.docs["pi.agent"] as { cwd?: string })?.cwd === next);
		const children = await until(agents.children, (value) => value?.[session.id]?.length === 2);
		const pwd = async (name: string, requestId: string) => {
			const child = children?.[session.id]?.find((entry) => entry.name === name);
			assert(child);
			await current.send(
				{
					text: `subagent ${JSON.stringify({ action: "send", name, message: "bash" })}`,
					requestId,
				},
				BACKGROUND_CONTEXT,
			);
			const view = await holdIn(
				owner,
				Chat,
				{ session: session.id, conversation: child.conversationId },
				"participant",
			);
			try {
				const settled = await until(
					view.view,
					(value) =>
						(value?.entries ?? []).some((entry) =>
							entry.model?.some((message) => message.role === "toolResult" && message.toolName === "bash"),
						),
					20_000,
				);
				// The answer's report runs the root once more: idle before the next message, which would steer it.
				await until(
					current.view,
					(value) =>
						text(value).includes(`<sender kind="subagent" name="${name}"/>`) &&
						!(value?.docs["pi.live"] as { run?: unknown } | undefined)?.run,
				);
				await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
				return { child, agent: settled?.docs["pi.agent"] as { cwd?: string }, settled };
			} finally {
				view.release();
			}
		};
		const follow = await pwd("follow", "follow-bash");
		assert.equal(follow.agent.cwd, next);
		assert.equal(follow.child.location, undefined);
		const result = (view: ConversationView | null | undefined) =>
			(view?.entries ?? [])
				.flatMap((entry) => entry.model ?? [])
				.find(
					(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "bash",
				)
				?.content.map((part) => (part.type === "text" ? part.text.trim() : ""))
				.join();
		assert.equal(result(follow.settled), next);
		const owned = await pwd("own", "own-bash");
		assert.equal(owned.agent.cwd, own);
		assert.deepEqual(owned.child.location, { cwd: own, env: null });
		assert.equal(result(owned.settled), own);
		// Prompt resources load where each conversation works: the subagent's own directory, the session's new one.
		const templates = async (conversation: number) => {
			const resources = owner.hold(PromptResources, { session: session.id, conversation }, BACKGROUND_CONTEXT);
			try {
				const listed = await until(resources.templates, (value) => Boolean(value?.length));
				return listed?.map((template) => template.name);
			} finally {
				resources.release();
			}
		};
		assert.deepEqual(await templates(owned.child.conversationId), ["mine"]);
		assert.deepEqual(await templates(follow.child.conversationId), ["theirs"]);
		assert.deepEqual(await templates(1), ["theirs"]);
		// A subagent's own location never refuses a move; a destination that is not configured does.
		await assert.rejects(
			sessions.relocate({ id: session.id, cwd: "/", env: "box" }, BACKGROUND_CONTEXT),
			/not configured/,
		);
		current.release();
	});
	/** A session in a directory of its own whose worker runs and is idle, with an open Chat. */
	const idleSession = async (name: string) => {
		const owner = fixture.browser(),
			sessions = await holdIn(owner, Sessions, {}, "owner"),
			status = await holdIn(owner, SessionStatus, {}, "reader");
		const start = join(fixture.workspace, `${name}-start`);
		const next = join(fixture.workspace, `${name}-next`);
		for (const directory of [start, next]) mkdirSync(directory);
		const session = await sessions.create({ cwd: start }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		let sent = 0;
		/** Sends a message to `handle` and waits for its answer and an idle worker. */
		const answers = async (ref = chat) => {
			const message = `message ${++sent}`;
			await ref.send({ text: message, requestId: `${name}-${sent}` }, BACKGROUND_CONTEXT);
			await until(ref.view, (view) => text(view).includes(`Echo: ${message}`));
			await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		};
		await answers();
		const before = await worker(session.id);
		assert.equal(before.running, true);
		/** Resolves when `handle` goes `gone` (its worker ended). */
		const gone = (ref = chat) =>
			new Promise<void>((resolve) => {
				// Its worker ended: the reference loses its object (loading again, or failed while it restarts).
				let stop: (() => void) | undefined;
				stop = follow(ref.state, (value) => {
					if (value.kind === "live") return;
					queueMicrotask(() => stop?.());
					resolve();
				});
			});
		/** Kills the worker process (a crash) and waits until the server saw it exit. */
		const kill = async () => {
			const { pid } = await worker(session.id);
			assert(pid);
			process.kill(pid, "SIGKILL");
			await fixture.server.host.root(async (ctx) => {
				await until((await ctx.get(Hosts, {})).workers, (value) => value?.[session.id]?.running === false);
			}, BACKGROUND_CONTEXT);
		};
		const cwdOf = (view: ConversationView | null | undefined) => (view?.docs["pi.agent"] as { cwd?: string })?.cwd;
		return { owner, sessions, session, chat, start, next, before, answers, gone, kill, cwdOf };
	};
	type Steps = RelocationSteps;
	/**
	 * `SessionWorkers.relocate` to `cwd` with the real steps (fence, catalog update, move, cancel) as the Sessions plugin
	 * runs them, except those `change` replaces (it gets the real ones to wrap).
	 */
	const relocateWith = (
		session: string,
		destination: string | { cwd: string; env: string | null },
		change: (real: Steps) => Partial<Steps>,
	) =>
		fixture.server.host.root(async (ctx) => {
			const to = typeof destination === "string" ? { cwd: destination, env: null } : destination;
			const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
			const catalog = await ctx.get(Catalog, {});
			const boundary = () => ctx.get(WorkerBoundary, { session: session });
			const real: Steps = {
				prepare: async () => {
					const result = await (await boundary()).prepare({ to }, ctx);
					return result.accepted ? undefined : (result.refusal ?? "refused");
				},
				update: async () => {
					await catalog.update({ id: session, ...to }, ctx);
				},
				move: async () => {
					await (await boundary()).relocate(to, ctx);
				},
				cancel: async () => {
					await (await boundary()).cancel(ctx);
				},
			};
			await workers.relocate(session, { ...real, ...change(real) });
		}, BACKGROUND_CONTEXT);
	const catalogCwd = (session: string) =>
		fixture.server.host.root(
			async (ctx) => (await (await ctx.get(Catalog, {})).get({ id: session }, ctx)).cwd,
			BACKGROUND_CONTEXT,
		);

	// The catalog is already moved when the worker fails to follow: the server restarts it, and the new worker starts at
	// the new location (its start reconciles the agent cwds). The failing step is simulated; the fence and restart are real.
	it("restarts a worker that cannot follow the move in place", async () => {
		const s = await idleSession("fallback");
		const gone = s.gone();
		let cancelled = false;
		await relocateWith(s.session.id, s.next, () => ({
			move: async () => {
				throw new Error("cannot follow");
			},
			cancel: async () => {
				cancelled = true;
			},
		}));
		assert.equal(cancelled, false, "the update succeeded: nothing to cancel");
		const after = await worker(s.session.id);
		assert.equal(after.running, true);
		assert((after.generation ?? 0) > (s.before.generation ?? 0), "a new worker");
		await gone; // a restart: the old worker's objects end
		s.chat.release();
		const current = await holdIn(s.owner, Chat, { session: s.session.id, conversation: 1 }, "participant");
		await until(current.view, (view) => s.cwdOf(view) === s.next);
		await current.send({ text: "bash", requestId: "fallback-bash" }, BACKGROUND_CONTEXT);
		const settled = await until(current.view, (view) => bashResults(view).length === 1);
		assert.equal(bashResults(settled)[0], s.next);
		current.release();
	});
	it("keeps the move when the restart after a failed follow fails too: the start failure is the worker's status", async () => {
		const s = await idleSession("fallback-fails");
		// The new location's environment is not configured: the restart is refused (as any start would be).
		await relocateWith(s.session.id, s.next, (real) => ({
			update: async () => {
				await real.update();
				await fixture.server.host.root(async (ctx) => {
					await (await ctx.get(Catalog, {})).update({ id: s.session.id, env: "missing" }, ctx);
				}, BACKGROUND_CONTEXT);
			},
			move: async () => {
				throw new Error("cannot follow");
			},
		}));
		assert.equal(await catalogCwd(s.session.id), s.next);
		const state = await worker(s.session.id);
		assert.equal(state.running, false);
		assert.match(state.error ?? "", /not configured/);
		s.chat.release();
		await s.sessions.archive({ id: s.session.id }, BACKGROUND_CONTEXT);
	});
	it("lifts the fence when the catalog update fails", async () => {
		const s = await idleSession("update-fails");
		await assert.rejects(
			relocateWith(s.session.id, s.next, () => ({
				update: async () => {
					throw new Error("catalog down");
				},
			})),
			/catalog down/,
		);
		assert.equal(await catalogCwd(s.session.id), s.start);
		assert.deepEqual(await worker(s.session.id), s.before, "the same worker");
		await s.answers(); // admitted: not fenced
		s.chat.release();
	});
	it("stops a worker whose fence cannot be lifted, or whose prepare failed after the fence", async () => {
		const s = await idleSession("cancel-fails");
		let gone = s.gone();
		await assert.rejects(
			relocateWith(s.session.id, s.next, () => ({
				update: async () => {
					throw new Error("catalog down");
				},
				cancel: async () => {
					throw new Error("cancel lost");
				},
			})),
			/catalog down/,
		);
		assert.equal((await worker(s.session.id)).running, false, "stopped, not left fenced");
		await gone;
		s.chat.release();
		// The next use starts a worker that admits again (at the old location: the catalog did not move).
		const chat = await holdIn(s.owner, Chat, { session: s.session.id, conversation: 1 }, "participant");
		await until(chat.view, (view) => s.cwdOf(view) === s.start);
		await s.answers(chat);
		gone = s.gone(chat);
		await assert.rejects(
			relocateWith(s.session.id, s.next, (real) => ({
				prepare: async () => {
					assert.equal(await real.prepare(), undefined);
					throw new Error("answer lost");
				},
			})),
			/answer lost/,
		);
		assert.equal((await worker(s.session.id)).running, false);
		await gone;
		assert.equal(await catalogCwd(s.session.id), s.start);
		chat.release();
	});
	it("moves only the catalog when the worker exits while being fenced", async () => {
		const s = await idleSession("prepare-races-exit");
		await relocateWith(s.session.id, s.next, () => ({
			prepare: async () => {
				await s.kill();
				throw new Error("link lost");
			},
		}));
		assert.equal(await catalogCwd(s.session.id), s.next);
		s.chat.release();
		const chat = await holdIn(s.owner, Chat, { session: s.session.id, conversation: 1 }, "participant");
		await until(chat.view, (view) => s.cwdOf(view) === s.next);
		chat.release();
	});
	// A subagent with its own location stays where it is, on another machine too: the worker's check under the fence
	// accepts such a move (it fails later only because no environment "box" exists here; envs.test.ts moves to one).
	it("accepts a move to another machine under the fence while a subagent has its own location", async () => {
		const s = await idleSession("own-location");
		const own = join(fixture.workspace, "own-location-own");
		mkdirSync(own);
		const spawn = { action: "spawn", name: "mine", message: "hi", cwd: own, tools: ["bash"] };
		await s.chat.send(
			{ text: `subagent ${JSON.stringify(spawn)}`, requestId: "own-location-spawn" },
			BACKGROUND_CONTEXT,
		);
		await until(
			s.chat.view,
			(view) =>
				text(view).includes('<sender kind="subagent" name="mine"/>') &&
				!(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run,
		);
		await s.answers();
		await fixture.server.host.root(async (ctx) => {
			const boundary = await ctx.get(WorkerBoundary, { session: s.session.id });
			const result = await boundary.prepare({ to: { cwd: "/", env: "box" } }, ctx);
			assert.equal(result.accepted, true);
			assert.equal(result.refusal, undefined);
			await boundary.cancel(ctx);
		}, BACKGROUND_CONTEXT);
		await s.answers(); // the fence is lifted
		assert.deepEqual(await worker(s.session.id), s.before, "the same worker");
		s.chat.release();
	});
	// Stops and catalog updates without the worker hold route resolution: a client arriving meanwhile waits and then
	// gets a worker, instead of failing as if it had called the dying one.
	it("lets a client arriving while the catalog moves for an exited worker wait for it", async () => {
		const s = await idleSession("arrival");
		let arriving: Held<typeof Chat> | undefined;
		await relocateWith(s.session.id, s.next, (real) => ({
			prepare: async () => {
				await s.kill();
				throw new Error("link lost");
			},
			update: async () => {
				// Held, not awaited: it waits for the relocation this step is part of.
				arriving = s.owner.hold(Chat, { session: s.session.id, conversation: 1 }, BACKGROUND_CONTEXT);
				await new Promise((resolve) => setTimeout(resolve, 300));
				await real.update();
			},
		}));
		assert(arriving);
		await whenLive(arriving);
		const arrival = liveIn(arriving, "participant")!;
		await until(arrival.view, (view) => s.cwdOf(view) === s.next);
		await s.answers(arrival);
		arrival.release();
		s.chat.release();
	});
	// A worker dying right before the move is asked: resolving its route must fail, not queue a start behind this very
	// relocation (which would wait for itself forever).
	it("does not hang when the worker dies between the fence and the move", async () => {
		const s = await idleSession("crash-before-move");
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			relocateWith(s.session.id, s.next, (real) => ({
				move: async () => {
					await s.kill();
					await real.move();
				},
			})),
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("the relocation hung")), 20_000);
			}),
		]).finally(() => clearTimeout(timer));
		assert.equal(await catalogCwd(s.session.id), s.next);
		s.chat.release();
		const chat = await holdIn(s.owner, Chat, { session: s.session.id, conversation: 1 }, "participant");
		await until(chat.view, (view) => s.cwdOf(view) === s.next);
		await s.answers(chat);
		chat.release();
	});
	// The steps run in a root of the server's own: whenever the caller gives up, the worker is never left fenced and
	// ends up where the catalog says.
	it("never leaves the worker fenced when the caller aborts", async () => {
		const s = await idleSession("abort");
		for (const [index, delay] of [0, 1, 3, 10, 30, 80].entries()) {
			const cwd = index % 2 === 0 ? s.next : s.start;
			const controller = new AbortController();
			const call = fixture.server.host.root(
				async (ctx) => {
					const sessions = expectVariant(await ctx.get(Sessions, {}), "owner");
					await sessions.relocate({ id: s.session.id, cwd, env: null }, ctx);
				},
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
				{ principal: { kind: "owner", access: "local" } },
			);
			setTimeout(() => controller.abort(), delay);
			await call.catch(() => {});
			// Admitted again within a short time, whatever happened to the move.
			await poll(
				async () => {
					try {
						await s.answers();
						return true;
					} catch (error) {
						if (error instanceof Error && /Working directory is changing/.test(error.message)) return false;
						throw error;
					}
				},
				10_000,
				"an admitted send",
			);
			const expected = await catalogCwd(s.session.id);
			await until(s.chat.view, (view) => s.cwdOf(view) === expected);
		}
		assert.deepEqual(await worker(s.session.id), s.before, "moved in place throughout");
		s.chat.release();
	});
	it("rejects foreground and named child work, and prevents new admission after an idle fence", async () => {
		const owner = fixture.browser(),
			sessions = await holdIn(owner, Sessions, {}, "owner"),
			status = await holdIn(owner, SessionStatus, {}, "reader");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const root = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await root.send({ text: "slow run", requestId: "slow" }, BACKGROUND_CONTEXT);
		// A refused move is a failed operation the owner sees (the call answered when the move started).
		const refused = async (pattern: RegExp) => {
			await sessions.relocate({ id: session.id, cwd: target, env: null }, BACKGROUND_CONTEXT);
			const list = await until(sessions.operations, (value) =>
				(value ?? []).some((each) => each.session === session.id && each.phase === "failed"),
			);
			const failure = list?.find((each) => each.session === session.id && each.phase === "failed");
			assert(failure?.phase === "failed");
			assert.match(failure.error, pattern);
			await sessions.dismissOperation({ operation: failure.id }, BACKGROUND_CONTEXT);
		};
		await refused(/Stop the current run/);
		// The refusal left no fence: input is admitted, and the session stayed where it was.
		await root.send({ text: "queued meanwhile", requestId: "queued", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		assert.equal(await catalogCwd(session.id), fixture.workspace);
		await root.stop(BACKGROUND_CONTEXT);
		await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		await root.send({ text: "subagent", requestId: "helper" }, BACKGROUND_CONTEXT);
		const agents = await holdIn(owner, Subagents, {}, "reader");
		const children = await until(agents.children, (value) => Boolean(value?.[session.id]?.length));
		const child = children?.[session.id]?.[0];
		assert(child);
		await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		const helper = await holdIn(
			owner,
			Chat,
			{ session: session.id, conversation: child.conversationId },
			"participant",
		);
		await helper.send({ text: "slow helper", requestId: "slow-child" }, BACKGROUND_CONTEXT);
		await refused(/Subagent helper is still running/);
		await helper.stop(BACKGROUND_CONTEXT);
		await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		await fixture.server.host.root(async (ctx) => {
			const boundary = await ctx.get(WorkerBoundary, { session: session.id });
			assert.equal((await boundary.prepare(null, ctx)).accepted, true);
			try {
				await assert.rejects(
					root.send({ text: "fenced", requestId: "fenced" }, BACKGROUND_CONTEXT),
					/Working directory is changing/,
				);
			} finally {
				await boundary.cancel(ctx);
			}
		}, BACKGROUND_CONTEXT);
		await root.send({ text: "unfenced", requestId: "unfenced" }, BACKGROUND_CONTEXT);
		await until(root.view, (view) => text(view).includes("Echo: unfenced"));
		await assert.rejects(
			owner.hold(WorkerBoundary, { session: session.id }, BACKGROUND_CONTEXT).prepare(null, BACKGROUND_CONTEXT),
			/server lifecycle only/,
		);
	});
});

// A worker that does not follow in time is restarted at the new location, like one whose move failed.
describe("session relocation: a move that hangs", () => {
	let fixture: Fixture;
	before(async () => {
		fixture = await startFixture({ moveTimeoutMs: 500 });
	});
	after(async () => {
		await fixture?.close();
	});
	it("restarts the worker once the move takes longer than the bound", async () => {
		const owner = fixture.browser(),
			sessions = await holdIn(owner, Sessions, {}, "owner"),
			status = await holdIn(owner, SessionStatus, {}, "reader");
		const next = join(fixture.workspace, "next");
		mkdirSync(next);
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "before", requestId: "before" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => text(view).includes("Echo: before"));
		await until(status.statuses, (value) => value?.[session.id]?.tasks === 0);
		const generation = () =>
			fixture.server.host.root(async (ctx) => {
				const hosts = await ctx.get(Hosts, {});
				return hosts.workers.value?.[session.id]?.generation ?? 0;
			}, BACKGROUND_CONTEXT);
		const before = await generation();
		const started = Date.now();
		await fixture.server.host.root(async (ctx) => {
			const workers = (await fixture.server.host.registry(ServerNatives, ctx)).value!.workers;
			const catalog = await ctx.get(Catalog, {});
			const boundary = () => ctx.get(WorkerBoundary, { session: session.id });
			await workers.relocate(session.id, {
				prepare: async () =>
					(await (await boundary()).prepare({ to: { cwd: next, env: null } }, ctx)).accepted
						? undefined
						: "refused",
				update: async () => {
					await catalog.update({ id: session.id, cwd: next, env: null }, ctx);
				},
				move: () => new Promise<void>(() => {}),
				cancel: async () => {
					await (await boundary()).cancel(ctx);
				},
			});
		}, BACKGROUND_CONTEXT);
		assert(Date.now() - started >= 500, "waited for the bound");
		assert((await generation()) > before, "a new worker");
		chat.release();
		const current = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await until(current.view, (view) => (view?.docs["pi.agent"] as { cwd?: string })?.cwd === next);
		current.release();
	});
});
