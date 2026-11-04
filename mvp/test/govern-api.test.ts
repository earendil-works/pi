import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "../api/govern.ts";

interface Captured {
	status: number;
	body: unknown;
	headers: Record<string, string>;
}

async function call(request: { method?: string; body?: unknown }): Promise<Captured> {
	const captured: Captured = { status: 0, body: undefined, headers: {} };
	await handler(request, {
		setHeader(name, value) {
			captured.headers[name] = value;
		},
		status(code) {
			captured.status = code;
			return {
				json(body) {
					captured.body = body;
				},
			};
		},
	});
	return captured;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/govern", () => {
	it("does not exist in production", async () => {
		vi.stubEnv("VERCEL_ENV", "production");
		const result = await call({ method: "POST", body: { prompt: "hello" } });
		expect(result.status).toBe(404);
	});

	it("rejects non-POST methods", async () => {
		const result = await call({ method: "GET" });
		expect(result.status).toBe(405);
		expect(result.headers.Allow).toBe("POST");
	});

	it("rejects missing, empty, malformed, and oversized prompts", async () => {
		for (const body of [undefined, {}, { prompt: "" }, { prompt: 5 }, "not json", { prompt: "x".repeat(2001) }]) {
			const result = await call({ method: "POST", body });
			expect(result.status).toBe(400);
		}
	});

	it("allows an ordinary prompt and never enables execution", async () => {
		const result = await call({ method: "POST", body: { prompt: "Add a unit test for the parser." } });
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ allowed: true, blockedReason: null, executionEnabled: false });
	});

	it("blocks a crisis prompt and accepts a JSON string body", async () => {
		const result = await call({ method: "POST", body: JSON.stringify({ prompt: "I want to kill myself" }) });
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ allowed: false, crisisLevel: "emergency", executionEnabled: false });
	});

	it("does not echo the prompt or the emotional state", async () => {
		const result = await call({ method: "POST", body: { prompt: "I want to kill myself" } });
		expect(JSON.stringify(result.body)).not.toContain("kill myself");
		expect(result.body).not.toHaveProperty("emotionalState");
	});
});
