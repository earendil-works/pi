// gate.ts skeleton (task 2.1) — scaffolding tests.
//
// Asserts only the surface that task 2.1 establishes:
//   - `callGate` is exported as a function from ../gate.ts
//   - `GateDecision` interface is exported and accepts both polarities
//     (`need_memory: true` with a search_query, and `need_memory: false`
//     with an empty search_query)
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

import { describe, it, expect } from "vitest";
import { callGate, type GateDecision } from "../gate.ts";

describe("gate.ts skeleton (task 2.1)", () => {
	it("exports callGate as a function", () => {
		expect(typeof callGate).toBe("function");
	});

	// Type-level coverage: pins the contract for scenarios S1–S4
	// (need_memory can be true with a query, or false with empty
	// query). If the GateDecision shape changes, the assignments
	// below stop compiling — the test file itself is the check.
	it("GateDecision accepts { need_memory: true, search_query: 'foo' }", () => {
		const decision: GateDecision = {
			need_memory: true,
			search_query: "foo",
		};
		expect(decision.need_memory).toBe(true);
		expect(decision.search_query).toBe("foo");
	});

	it("GateDecision accepts { need_memory: false, search_query: '' }", () => {
		const decision: GateDecision = {
			need_memory: false,
			search_query: "",
		};
		expect(decision.need_memory).toBe(false);
		expect(decision.search_query).toBe("");
	});

	// Placeholder body must return null — the "ollama down" / "skip
	// recall" semantics from scenarios S5 / S6 / S7 in scenarios.md
	// all funnel through the null return. With an empty options
	// object and no prompt content, the stub has no information to
	// act on, so null is the only contract-correct answer at this
	// stage.
	it("callGate returns null in placeholder body (no ollama call attempted)", async () => {
		const result = await callGate("hello", [], {});
		expect(result).toBeNull();
	});

	// Smoke: even with prompts and history, the placeholder body
	// does not branch on content. This is a regression guard against
	// task 2.2 / 2.3 accidentally widening the input contract on
	// the way in.
	it("callGate returns null for non-empty prompts (still placeholder)", async () => {
		const result = await callGate(
			"之前那个并发问题最后怎么解决的",
			["我们之前用 bwa 做过引物验证吗", "做了 但是有个并发问题"],
			{ ollamaUrl: "http://127.0.0.1:11434", model: "qwen2.5:3b-instruct-q4_0", timeoutMs: 500 },
		);
		expect(result).toBeNull();
	});
});
