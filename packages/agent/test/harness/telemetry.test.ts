import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"pi.harness.run",
			"pi.harness.compaction",
			"pi.harness.navigation",
			"pi.harness.checkpoint",
			"pi.harness.turn",
			"pi.harness.step",
			"pi.harness.tool",
			"pi.harness.hook",
			"pi.harness.sleep",
			"pi.harness.event_handler",
			"pi.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"pi.harness.step",
			{
				"pi.lane.name": "main",
				"pi.operation.id": "operation",
				"pi.step.kind": "assistant",
				"pi.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "pi.step.outcome": "succeeded" });
				await startChildSpan(
					"pi.ai.request",
					{
						"pi.ai.operation": "stream",
						"pi.ai.provider": "provider",
						"pi.ai.model": "model",
						"pi.ai.api": "api",
						"pi.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "pi.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"pi.ai.request">;
		type End = AiSpanEndAttributes<"pi.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"pi.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"pi.ai.provider": string;
			"pi.ai.model": string;
			"pi.ai.api": string;
			"pi.ai.streaming": boolean;
			"pi.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["pi.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startAiSpan(
			telemetryContext,
			"pi.ai.request",
			{
				"pi.ai.operation": "stream",
				"pi.ai.provider": "provider",
				"pi.ai.model": "model",
				"pi.ai.api": "api",
				"pi.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "pi.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error pi.ai.request declares no span events
				span.addEvent("chunk");
			},
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"pi.ai.operation": "stream",
				"pi.ai.provider": "provider",
				"pi.ai.model": "model",
				"pi.ai.api": "api",
				"pi.ai.streaming": true,
				"pi.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan(telemetryContext, "pi.ai.request", extraAttributes, () => {});
			// @ts-expect-error missing required start attributes
			void startAiSpan(telemetryContext, "pi.ai.request", { "pi.ai.operation": "stream" }, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"pi.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"pi.harness.run">;
		expectTypeOf<RunStart["pi.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["pi.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startHarnessSpan(
			telemetryContext,
			"pi.harness.run",
			{
				"pi.session.id": "session",
				"pi.lane.name": "main",
				"pi.operation.id": "operation",
				"pi.operation.kind": "run",
				"pi.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "pi.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"pi.session.id": "session",
				"pi.lane.name": "main",
				"pi.operation.id": "operation",
				"pi.operation.kind": "run",
				"pi.operation.recovery": false,
				"pi.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan(telemetryContext, "pi.harness.run", extraRunAttributes, () => {});
			void startHarnessSpan(
				telemetryContext,
				"pi.harness.checkpoint",
				{
					"pi.lane.name": "main",
					"pi.operation.id": "operation",
					"pi.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "pi.unknown": true });
				},
			);
			void startHarnessSpan(
				telemetryContext,
				"pi.harness.run",
				{
					"pi.session.id": "session",
					"pi.lane.name": "main",
					"pi.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"pi.operation.kind": "navigation",
					"pi.operation.recovery": false,
				},
				() => {},
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan(telemetryContext, "pi.harness.run", {}, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
