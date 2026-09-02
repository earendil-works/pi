import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const registration = vi.hoisted(() => ({
	module: { stream: Symbol("stream"), streamSimple: Symbol("streamSimple") },
	registered: [] as object[],
}));

vi.mock("@earendil-works/pi-ai/anthropic-vertex-provider", () => ({
	anthropicVertexProviderModule: registration.module,
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
	setAnthropicVertexProviderModule: (module: object) => {
		registration.registered.push(module);
	},
}));

import "../src/bun/register-anthropic-vertex.ts";

describe("Bun Anthropic Vertex registration", () => {
	it("registers the statically imported provider module", () => {
		expect(registration.registered).toEqual([registration.module]);
	});

	it("keeps the literal registration import after sandbox environment restoration", () => {
		const source = readFileSync(new URL("../src/bun/cli.ts", import.meta.url), "utf8");
		const restoreIndex = source.indexOf("restoreSandboxEnv();");
		const registrationIndex = source.indexOf('await import("./register-anthropic-vertex.ts");');

		expect(restoreIndex).toBeGreaterThanOrEqual(0);
		expect(registrationIndex).toBeGreaterThan(restoreIndex);
		expect(source).not.toContain('import "./register-anthropic-vertex.ts";');
	});
});
