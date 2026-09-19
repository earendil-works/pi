import assert from "node:assert/strict";
import { createContextKey, withContextValue } from "@earendil-works/chord/context";
import { onTestFinished, test } from "vitest";
import { NestedLineOperation } from "../../../src/harness/pico3/session.ts";
import { type CoreTx, defineTask, Forbidden, type Namespace, type Runtime } from "../../../src/harness/pico3/types.ts";
import { ctx, Gate, open } from "./helpers.ts";

test("line context is propagated and cannot re-enter commit, reads, watches, or waiter registration", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const callerKey = createContextKey<string>("pico3.spec.caller");
	const callerContext = withContextValue(callerKey, "caller-value", ctx);
	let lineContext = ctx;

	await env.root.commit((_tx, currentContext) => {
		assert.equal(currentContext.value(callerKey), "caller-value");
		lineContext = currentContext;
	}, callerContext);

	await assert.rejects(
		env.root.commit(() => undefined, lineContext),
		NestedLineOperation,
	);
	await assert.rejects(env.root.write({ kind: "note" }, lineContext), NestedLineOperation);
	await assert.rejects(env.root.watch(lineContext), NestedLineOperation);
	await assert.rejects(env.h.root(lineContext), NestedLineOperation);
	await assert.rejects(env.h.getTask(999_999, lineContext), NestedLineOperation);
	await assert.rejects(env.h.waitForTask(999_999, lineContext), NestedLineOperation);
	await assert.rejects(env.root.waitForIdle(lineContext), NestedLineOperation);
});

test("ordinary task scope covers its owned subtree but rejects every foreign direct and off-line read after malicious casts", async () => {
	const results = new Map<string, unknown>();
	let foreignConversation = 0;
	let foreignEntry = 0;
	let foreignInput = 0;
	let foreignTask = 0;
	let child = 0;
	let grandchild = 0;

	const probe = defineTask<null, { phase: "done" }, null, null, null>({
		name: "spec.scope.probe",
		async initial(_task, runtime, context) {
			child = await runtime.commit((tx) => tx.createConversation({}), context);
			grandchild = await runtime.commit(
				(tx) => tx.createConversation({ parent: { conversationId: child, at: "start" } }),
				context,
			);
			await runtime.commit(async (tx) => {
				await tx.write(child, { kind: "owned.child" });
				await tx.write(grandchild, { kind: "owned.grandchild" });
				assert.equal((await tx.conversation(child))?.owner, runtime.taskId);
				assert.equal((await tx.conversation(grandchild))?.owner, runtime.taskId);
			}, context);
			await runtime.context(grandchild, undefined, context);
			await runtime.rewindable(child, context);
			await runtime.sticky(grandchild, context);

			const attempts: Record<string, () => Promise<unknown>> = {
				"tx.conversation": () => runtime.commit((tx) => tx.conversation(foreignConversation), context),
				"tx.entry": () => runtime.commit((tx) => tx.entry(foreignEntry), context),
				"tx.entries": () => runtime.commit((tx) => tx.entries([foreignEntry]), context),
				"tx.input": () => runtime.commit((tx) => tx.input(foreignInput), context),
				"tx.task": () => runtime.commit((tx) => tx.task(foreignTask), context),
				"tx.snapshot": () =>
					runtime.commit((tx) => tx.snapshot({ doc: "sticky", conversationId: foreignConversation }), context),
				"tx.config": () => runtime.commit((tx) => tx.config(foreignConversation).get("profile"), context),
				"tx.write": () => runtime.commit((tx) => tx.write(foreignConversation, { kind: "intrusion" }), context),
				"tx.createTask": () =>
					runtime.commit(
						(tx) => tx.createTask(probe, null, { conversationId: foreignConversation, background: true }),
						context,
					),
				"tx.createConversation(parent)": () =>
					runtime.commit(
						(tx) => tx.createConversation({ parent: { conversationId: foreignConversation, at: "start" } }),
						context,
					),
				"runtime.context": () => runtime.context(foreignConversation, undefined, context),
				"runtime.newestEntry": () => runtime.newestEntry(foreignConversation, {}, context),
				"runtime.rewindable": () => runtime.rewindable(foreignConversation, context),
				"runtime.sticky": () => runtime.sticky(foreignConversation, context),
				"runtime.rewindableAsOf": () => runtime.rewindableAsOf(foreignConversation, foreignEntry, context),
				"runtime.sendOwned": () => runtime.sendOwned(foreignConversation, { content: "intrusion" }, context),
				"runtime.abortConversation": () => runtime.abortConversation(foreignConversation, context),
			};
			for (const [name, attempt] of Object.entries(attempts)) {
				try {
					await attempt();
					results.set(name, "allowed");
				} catch (error) {
					results.set(name, error);
				}
			}
			return { next: { phase: "done" } };
		},
		phases: {
			async done() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});

	const foreignKind = defineTask<null, { phase: "done" }, null, null, null>({
		name: "spec.scope.foreign-task",
		async initial() {
			return { next: { phase: "done" } };
		},
		phases: {
			async done() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({ taskKinds: [probe, foreignKind] });
	onTestFinished(() => env.close());
	const foreign = await env.h.createConversation({}, ctx);
	foreignConversation = foreign.id;
	foreignEntry = await foreign.write({ kind: "foreign.entry" }, ctx).then(async (inputId) => {
		foreignInput = inputId;
		return (await foreign.commit((tx) => tx.input(inputId), ctx))!.entry!;
	});
	foreignTask = (
		await foreign.commit(
			(tx) => tx.createTask(foreignKind, null, { conversationId: foreign.id, background: true }),
			ctx,
		)
	).id;
	await env.h.waitForTask(foreignTask, ctx);

	const ref = await env.root.commit(
		(tx) => tx.createTask(probe, null, { conversationId: env.root.id, background: true }),
		ctx,
	);
	await env.h.waitForTask(ref.id, ctx);

	assert.ok(child > 0 && grandchild > 0);
	assert.equal(results.size, 17);
	for (const [name, result] of results) {
		assert.ok(result instanceof Forbidden, `${name} unexpectedly produced ${String(result)}`);
	}
});

test("a runtime captured by one phase expires when that phase method returns, not only when the whole phase loop ends", async () => {
	const phaseGate = new Gate();
	let captured: Runtime | undefined;
	let state!: Namespace<{ latePhaseWritten: boolean }>;
	const kind = defineTask<null, { phase: "later" }, null, null, null>({
		name: "spec.phase.capability-lifetime",
		async initial(_task, runtime) {
			captured = runtime;
			return { next: { phase: "later" } };
		},
		phases: {
			async later(_task, _runtime, context) {
				await phaseGate.wait(context);
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({ taskKinds: [kind] });
	onTestFinished(() => env.close());
	state = env.h.namespace("test.phase-capability", { sticky: { latePhaseWritten: false } });
	const ref = await env.root.commit(
		(tx) => tx.createTask(kind, null, { conversationId: env.root.id, background: true }),
		ctx,
	);
	await phaseGate.arrivals(1);

	let lateError: unknown;
	try {
		await captured!.commit((tx) => {
			tx.plugins(state).latePhaseWritten = true;
		}, ctx);
	} catch (error) {
		lateError = error;
	}
	phaseGate.open();
	await env.h.waitForTask(ref.id, ctx);

	assert.ok(lateError instanceof Forbidden, `late phase runtime was accepted: ${String(lateError)}`);
	assert.equal((await env.root.sticky(ctx)).plugins["test.phase-capability"], undefined);
});

test("runtime capability checks remain authoritative after structural casts and forged task metadata", async () => {
	const observed: unknown[] = [];
	const definition = defineTask<null, { phase: "done" }, null, null, null>({
		name: "spec.cast.authority",
		async initial(_task, runtime, context) {
			for (const operation of [
				(tx: CoreTx) => tx.appendEntry(runtime.conversationId, { kind: "forged.entry" }),
				(tx: CoreTx) => tx.send(runtime.conversationId, { content: "forged input" }),
				(tx: CoreTx) => tx.resolveInputs([1], { status: "done", answer: 1 }),
				(tx: CoreTx) => tx.markTask(runtime.taskId),
			]) {
				try {
					await runtime.commit((tx) => operation(tx as unknown as CoreTx), context);
					observed.push("allowed");
				} catch (error) {
					observed.push(error);
				}
			}
			return { next: { phase: "done" } };
		},
		phases: {
			async done() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const kind = { ...definition, core: true };
	const env = await open({ taskKinds: [kind] });
	onTestFinished(() => env.close());
	const ref = await env.root.commit(
		(tx) => tx.createTask(kind, null, { conversationId: env.root.id, background: true }),
		ctx,
	);
	await env.h.waitForTask(ref.id, ctx);
	assert.equal(observed.length, 4);
	assert.ok(observed.every((value) => value instanceof Forbidden));
});
