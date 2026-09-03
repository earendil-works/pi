import { describe, expect, it } from "vitest";
import { getModelDisplayLabel, isOpaqueModelId } from "../src/core/model-display.ts";

const arn = "arn:aws:bedrock:eu-central-1:306656769644:application-inference-profile/9ljl0hmyfkly";
const arnGov = "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/abc";

describe("isOpaqueModelId", () => {
	it("matches Bedrock application inference profile ARNs", () => {
		expect(isOpaqueModelId(arn)).toBe(true);
	});

	it("matches Bedrock inference profile ARNs (including GovCloud)", () => {
		expect(isOpaqueModelId("arn:aws:bedrock:us-east-1:123456789012:inference-profile/xyz")).toBe(true);
		expect(isOpaqueModelId(arnGov)).toBe(true);
	});

	it("does not match ordinary model IDs", () => {
		expect(isOpaqueModelId("gpt-5")).toBe(false);
		expect(isOpaqueModelId("claude-sonnet-4-5")).toBe(false);
		expect(isOpaqueModelId("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(false);
	});
});

describe("getModelDisplayLabel", () => {
	const opaque = { id: arn, name: "juergen-botz-haiku-4-5" };
	const normal = { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };

	it("auto: uses name only when the id is opaque", () => {
		expect(getModelDisplayLabel(opaque, "auto")).toBe("juergen-botz-haiku-4-5");
		expect(getModelDisplayLabel(normal, "auto")).toBe("claude-sonnet-4-5");
	});

	it("auto is the default mode", () => {
		expect(getModelDisplayLabel(opaque)).toBe("juergen-botz-haiku-4-5");
		expect(getModelDisplayLabel(normal)).toBe("claude-sonnet-4-5");
	});

	it("id: always returns the id", () => {
		expect(getModelDisplayLabel(opaque, "id")).toBe(arn);
		expect(getModelDisplayLabel(normal, "id")).toBe("claude-sonnet-4-5");
	});

	it("name: always returns the name", () => {
		expect(getModelDisplayLabel(opaque, "name")).toBe("juergen-botz-haiku-4-5");
		expect(getModelDisplayLabel(normal, "name")).toBe("Claude Sonnet 4.5");
	});

	it("falls back to id when name is missing or blank", () => {
		expect(getModelDisplayLabel({ id: arn, name: "" }, "auto")).toBe(arn);
		expect(getModelDisplayLabel({ id: arn, name: "   " }, "name")).toBe(arn);
	});
});
