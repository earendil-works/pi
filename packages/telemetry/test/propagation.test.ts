import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_PROPAGATION,
	type RecordedTelemetrySpan,
	type SpanAttributes,
	type TelemetryCarrier,
	type TelemetrySpan,
} from "../src/index.ts";

describe("propagation and links", () => {
	it("continues a parent in another Node process without shared recorder state", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let carrier: TelemetryCarrier | undefined;
		await telemetry.startSpan({ name: "caller" }, (span) => {
			carrier = telemetry.inject(span);
		});
		const output = execFileSync(
			process.execPath,
			[fileURLToPath(new URL("./propagation-worker.ts", import.meta.url)), JSON.stringify(carrier)],
			{ encoding: "utf8" },
		);
		const recorded = JSON.parse(output) as RecordedTelemetrySpan[];
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.parentContext).toEqual(carrier);
		expect(recorded[0]?.parentId).toBeNull();
		expect(recorded[0]?.context).not.toEqual(carrier);
	});

	it("isolates crossed concurrent remote parents and links shared roots", async () => {
		const caller = new InMemoryTelemetryContext();
		const provider = new InMemoryTelemetryContext();
		let activation: TelemetrySpan | undefined;
		let finishActivation: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			finishActivation = resolve;
		});
		let shared: Promise<void> | undefined;
		await Promise.all(
			["first", "later"].map((name) =>
				caller.startSpan({ name }, async (trigger) => {
					const parent = provider.extract(caller.inject(trigger));
					await parent.startSpan({ name: `${name}.method` }, async (getter) => {
						if (!shared)
							shared = provider.startSpan({ name: "activation", links: [{ context: getter }] }, async (span) => {
								activation = span;
								await gate;
							});
						if (activation) getter.addLink({ context: activation });
						if (name === "later") finishActivation?.();
						await shared;
					});
				}),
			),
		);
		const spans = provider.getSpans();
		const root = spans.find((span) => span.name === "activation");
		expect(root?.parentContext).toBeNull();
		const first = spans.find((span) => span.name === "first.method");
		const later = spans.find((span) => span.name === "later.method");
		expect(first?.parentContext).toEqual(caller.getSpans()[0]?.context);
		expect(later?.parentContext).toEqual(caller.getSpans()[1]?.context);
		expect(root?.links[0]?.context).toEqual(first?.context);
		expect(later?.links[0]?.context).toEqual(root?.context);
	});

	it("detaches carrier and link snapshots and retains settled target identities", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let target: TelemetrySpan | undefined;
		await telemetry.startSpan({ name: "target" }, (span) => {
			target = span;
		});
		if (!target) throw new Error("Expected target");
		const original = telemetry.inject(target);
		const injected = telemetry.inject(target);
		if (!injected) throw new Error("Expected carrier");
		injected["pi-memory-span"] = "999";
		expect(telemetry.inject(target)).toEqual(original);
		await telemetry.startSpan(
			{ name: "linked", links: [{ context: target, attributes: { tags: ["original"] } }] },
			() => {},
		);
		const [first, linked] = telemetry.getSpans();
		if (!first || !linked?.links[0]) throw new Error("Expected spans and link");
		(first.context as TelemetryCarrier)["pi-memory-span"] = "123";
		(linked.links[0].context as TelemetryCarrier)["pi-memory-span"] = "456";
		(linked.links[0].attributes as SpanAttributes).tags = ["mutated"];
		expect(telemetry.getSpans()[1]?.links).toEqual([{ context: original, attributes: { tags: ["original"] } }]);
	});

	it("links a new root to an extracted remote target", async () => {
		const sender = new InMemoryTelemetryContext();
		const receiver = new InMemoryTelemetryContext();
		let carrier: TelemetryCarrier | undefined;
		await sender.startSpan({ name: "trigger" }, (span) => {
			carrier = sender.inject(span);
		});
		const target = receiver.extract(JSON.parse(JSON.stringify(carrier)) as TelemetryCarrier);
		await receiver.startSpan(
			{ name: "background", links: [{ context: target, attributes: { reason: "restart" } }] },
			(span) => {
				span.addLink({ context: target });
			},
		);
		const [recorded] = receiver.getSpans();
		expect(recorded?.parentContext).toBeNull();
		expect(recorded?.links).toEqual([
			{ context: carrier, attributes: { reason: "restart" } },
			{ context: carrier, attributes: {} },
		]);
	});

	it("uses the root for absent and unknown carriers", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const carriers: readonly (TelemetryCarrier | undefined)[] = [undefined, {}, { unknown: "format" }];
		for (const carrier of carriers) {
			expect(telemetry.extract(carrier)).toBe(telemetry);
		}
		expect(NOOP_TELEMETRY_PROPAGATION.inject(NOOP_TELEMETRY_CONTEXT)).toBeUndefined();
		expect(NOOP_TELEMETRY_PROPAGATION.extract({ unknown: "format" })).toBe(NOOP_TELEMETRY_CONTEXT);
		await NOOP_TELEMETRY_CONTEXT.startSpan({ name: "noop" }, (span) => {
			span.addLink({ context: span });
		});
	});

	it("treats recognized carrier identifiers as opaque strings", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const carrier = {
			"pi-memory-scope": "external-recorder",
			"pi-memory-span": "external-span",
			"pi-memory-trace": "external-trace",
		};
		await telemetry.extract(carrier).startSpan({ name: "receiver" }, () => {});
		expect(telemetry.getSpans()[0]?.parentContext).toEqual(carrier);
	});
});
