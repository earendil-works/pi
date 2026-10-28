import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	createContextKey,
	TODO_CONTEXT,
	traceIn,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
	withTelemetry,
} from "../src/context/index.ts";

describe("Context", () => {
	it("provides distinct empty root contexts", () => {
		const key = createContextKey<string>("value");

		expect(TODO_CONTEXT).not.toBe(BACKGROUND_CONTEXT);
		expect(TODO_CONTEXT.abortSignal).toBeUndefined();
		expect(TODO_CONTEXT.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
		expect(BACKGROUND_CONTEXT.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
		expect(TODO_CONTEXT.value(key)).toBeUndefined();
		expect(String(BACKGROUND_CONTEXT)).toBe("[Context BACKGROUND_CONTEXT]");
		expect(String(TODO_CONTEXT)).toBe("[Context TODO_CONTEXT]");
	});

	it("layers typed values without modifying parents", () => {
		const firstKey = createContextKey<string>("first");
		const secondKey = createContextKey<number>("second");
		const first = withContextValue(firstKey, "one", BACKGROUND_CONTEXT);
		const second = withContextValue(secondKey, 2, first);
		const replaced = withContextValue(firstKey, "updated", second);

		expect(BACKGROUND_CONTEXT.value(firstKey)).toBeUndefined();
		expect(first.value(firstKey)).toBe("one");
		expect(first.value(secondKey)).toBeUndefined();
		expect(second.value(firstKey)).toBe("one");
		expect(second.value(secondKey)).toBe(2);
		expect(replaced.value(firstKey)).toBe("updated");
		expect(second.value(firstKey)).toBe("one");
		expect(String(replaced)).toBe("[Context BACKGROUND_CONTEXT].WithValue(first).WithValue(second).WithValue(first)");
	});

	it("inherits parent cancellation and isolates child cancellation", () => {
		const parentController = new AbortController();
		const parent = withAbortSignal(parentController.signal, BACKGROUND_CONTEXT);
		const child = withCancel(parent);
		const sibling = withCancel(parent);
		const childListener = vi.fn();
		child.context.abortSignal?.addEventListener("abort", childListener);

		child.cancel("child");
		expect(child.context.abortSignal?.aborted).toBe(true);
		expect(child.context.abortSignal?.reason).toBe("child");
		expect(sibling.context.abortSignal?.aborted).toBe(false);
		expect(parent.abortSignal?.aborted).toBe(false);
		expect(childListener).toHaveBeenCalledOnce();

		parentController.abort("parent");
		expect(sibling.context.abortSignal?.aborted).toBe(true);
		expect(sibling.context.abortSignal?.reason).toBe("parent");
	});

	it("masks caller cancellation for mandatory cleanup", () => {
		const controller = new AbortController();
		const key = createContextKey<string>("value");
		const context = withContextValue(key, "preserved", withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		const cleanup = withoutAbortSignal(context);

		controller.abort();
		expect(context.abortSignal?.aborted).toBe(true);
		expect(cleanup.abortSignal).toBeUndefined();
		expect(cleanup.value(key)).toBe("preserved");
	});

	it("derives telemetry independently from values and cancellation", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const other = new InMemoryTelemetryContext();
		await telemetry.startSpan({ name: "caller" }, (parent) =>
			other.startSpan({ name: "other" }, async (otherSpan) => {
				const key = createContextKey<string>("principal");
				const controller = new AbortController();
				const base = withContextValue(key, "owner", withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
				const context = withTelemetry(parent, base);
				const replaced = withTelemetry(otherSpan, context);
				expect(base.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
				expect(context.telemetry).toBe(parent);
				expect(replaced.telemetry).toBe(otherSpan);
				expect(replaced.value(key)).toBe("owner");
				expect(replaced.abortSignal).toBe(base.abortSignal);
				expect(withoutAbortSignal(context).telemetry).toBe(parent);
				await traceIn(
					{ name: "outer" },
					async (child) => {
						expect(child.value(key)).toBe("owner");
						expect(child.abortSignal).toBe(context.abortSignal);
						child.telemetry.addEvent("started");
						await traceIn(
							{ name: "inner" },
							(nested) => {
								nested.telemetry.addLink({ context: child.telemetry });
								return 42;
							},
							child,
						);
					},
					context,
				);
				const [caller, outer, inner] = telemetry.getSpans();
				expect(outer?.parentId).toBe(caller?.id);
				expect(inner?.parentId).toBe(outer?.id);
				expect(inner?.links[0]?.context).toEqual(outer?.context);
				expect(context.telemetry).toBe(parent);
				controller.abort();
				expect(context.abortSignal?.aborted).toBe(true);
			}),
		);
	});

	it("isolates concurrent traceIn branches and preserves callback results and errors", async () => {
		const telemetry = new InMemoryTelemetryContext();
		await telemetry.startSpan({ name: "caller" }, async (parent) => {
			const context = withTelemetry(parent, BACKGROUND_CONTEXT);
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const first = traceIn(
				{ name: "first" },
				async (child) => {
					await gate;
					return traceIn({ name: "first.child" }, () => "first", child);
				},
				context,
			);
			const second = traceIn(
				{ name: "second" },
				async (child) => {
					const result = await traceIn({ name: "second.child" }, () => "second", child);
					release?.();
					return result;
				},
				context,
			);
			expect(await Promise.all([first, second])).toEqual(["first", "second"]);
			const spans = telemetry.getSpans();
			for (const name of ["first", "second"]) {
				const parent = spans.find((span) => span.name === name);
				expect(spans.find((span) => span.name === `${name}.child`)?.parentId).toBe(parent?.id);
			}
			const failure = { reason: "same value" };
			await expect(
				traceIn(
					{ name: "throw" },
					() => {
						throw failure;
					},
					context,
				),
			).rejects.toBe(failure);
			await expect(traceIn({ name: "reject" }, () => Promise.reject(failure), context)).rejects.toBe(failure);
			expect(
				await traceIn(
					{ name: "noop" },
					(child) => {
						child.telemetry.addLink({ context: parent });
						return 42;
					},
					BACKGROUND_CONTEXT,
				),
			).toBe(42);
		});
	});

	it("stops waiting when the invocation is cancelled", async () => {
		const controller = new AbortController();
		const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		let resolveWork!: (value: string) => void;
		const work = new Promise<string>((resolve) => {
			resolveWork = resolve;
		});
		const waiting = awaitWithContext(work, context);
		const cancellation = new Error("cancelled");

		controller.abort(cancellation);
		await expect(waiting).rejects.toBe(cancellation);
		resolveWork("completed later");
		await expect(work).resolves.toBe("completed later");
		await expect(awaitWithContext(Promise.resolve("completed"), BACKGROUND_CONTEXT)).resolves.toBe("completed");
	});
});
