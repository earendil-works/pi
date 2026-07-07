// gate.ts skeleton (task 2.1) — scaffolding tests.
//
// Asserts only the surface that task 1.1 establishes:
//   - `callGate` is exported as a function from ../gate.ts
//   - `GateDecision` interface is exported and accepts both polarities
//     (`need_memory: true` and `need_memory: false`)
//   - the placeholder body returns `null` regardless of input — the
//     network protocol (ollama POST /api/chat, JSON parsing, timeout)
//     is filled in by task 2.2 / 2.3; this test just pins the
//     initial behaviour to break the build before any of that lands.
//
// Why a test on a stub that always returns null? Two reasons:
//   1. The base layer (signature + null return) is the contract that
//      every later task (2.2 prompt, 2.3 fetch+parse+timeout, 5.2
//      pipeline integration) builds on. A drift here — e.g. someone
//      flips the placeholder to `throw` — would silently change the
//      "ollama-down → skip recall" semantics defined in scenarios
//      S6 / S7 in scenarios.md.
//   2. It forces the file to exist and the export set to be stable
//      before any production code touches it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGate, type GateDecision } from "../gate.ts";

describe("gate.ts skeleton (task 2.1)", () => {
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exports callGate as a function", () => {
		expect(typeof callGate).toBe("function");
	});

	// Type-level coverage: pins the contract for scenarios S1–S4
	// (need_memory can be true or false). If the GateDecision shape
	// changes, the assignments below stop compiling — the test file
	// itself is the check.
	it("GateDecision accepts { need_memory: true }", () => {
		const decision: GateDecision = {
			need_memory: true,
		};
		expect(decision.need_memory).toBe(true);
	});

	it("GateDecision accepts { need_memory: false }", () => {
		const decision: GateDecision = {
			need_memory: false,
		};
		expect(decision.need_memory).toBe(false);
	});

	// callGate degrades to a typed error on fetch rejection (S6/S7 in
	// scenarios.md — ECONNREFUSED → "unreachable", timeout → "timeout").
	// Mocking fetch to reject validates the degradation path without
	// requiring a running ollama. The contract was widened from null →
	// "unreachable" so the TUI can surface a specific failure mode; this
	// test pins the post-widening behaviour.
	it("callGate returns 'unreachable' when ollama is unreachable (ECONNREFUSED → S7)", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
		const result = await callGate("hello", [], {});
		expect(result).toBe("unreachable");
	});

	// Even with full options the fetch failure path still returns the
	// typed error. Regression guard against any further widening of the
	// return-value contract.
	it("callGate returns 'unreachable' for non-empty prompts when ollama is unreachable", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
		const result = await callGate(
			"之前那个并发问题最后怎么解决的",
			["我们之前用 bwa 做过引物验证吗", "做了 但是有个并发问题"],
			{ ollamaUrl: "http://127.0.0.1:11434", model: "qwen2.5:3b-instruct-q4_0", timeoutMs: 500 },
		);
		expect(result).toBe("unreachable");
	});
});
