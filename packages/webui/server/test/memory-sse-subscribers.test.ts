// Tests for the SSE subscriber table + heartbeat (Task 2.3).
//
// Covers:
//  - subscribeAtom adds res to the per-atom Set (verified via broadcast reach)
//  - broadcastAtomUpdate sends an `event: atom` frame to all subscribers
//  - res.on('close') removes the res from the Set
//  - broadcastAtomUpdate with no subscribers is a no-op
//  - heartbeat fires `: ping\n\n` at SSE_HEARTBEAT_MS (vi.useFakeTimers)
//
// The module-level `subscribers` Map is shared across tests in this file.
// afterEach triggers the close handler on every mock created in the test so
// the Map doesn't leak entries into the next test. The handlers clear the
// interval BEFORE vi.useRealTimers() so the fake→real transition does not
// leak a pending timer.

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import {
	SSE_HEARTBEAT_MS,
	broadcastAtomUpdate,
	subscribeAtom,
} from "../routes/memory.ts";
import type { MemoryAtom } from "@earendil-works/pi-personal-assistant";

// --- Mock Response -----------------------------------------------------------
//
// Minimal shape that matches what memory.ts actually touches: `write(chunk)`
// and `on('close', cb)`. The cast to express.Response happens at the call
// site (`as unknown as express.Response`) so this file does not depend on
// the full Express type surface.
interface MockRes {
	chunks: string[];
	on: (event: string, cb: () => void) => void;
	write: (chunk: string) => boolean;
	triggerClose: () => void;
}

function createMockRes(): MockRes {
	const chunks: string[] = [];
	let closeCb: (() => void) | undefined;
	return {
		chunks,
		on(event: string, cb: () => void) {
			if (event === "close") closeCb = cb;
		},
		write(chunk: string) {
			chunks.push(chunk);
			return true;
		},
		triggerClose() {
			closeCb?.();
		},
	};
}

// --- Test atom factory -------------------------------------------------------

function makeAtom(overrides: Partial<MemoryAtom> = {}): MemoryAtom {
	return {
		id: "a1",
		type: "rule",
		title: "T",
		content: "C",
		summary: "S",
		tags: [],
		importance: 0.5,
		strength: 0.5,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: 0,
		updated_at: 0,
		last_access: null,
		content_fingerprint: "fp",
		source_session: null,
		...overrides,
	};
}

// --- Per-test mock tracking --------------------------------------------------

const createdMocks: MockRes[] = [];
function newMock(): MockRes {
	const m = createMockRes();
	createdMocks.push(m);
	return m;
}

// --- Tests -------------------------------------------------------------------

describe("memory SSE subscribers (Task 2.3)", () => {
	afterEach(() => {
		// Close every mock first so the close handler clears the fake
		// interval before we restore real timers.
		for (const m of createdMocks) m.triggerClose();
		createdMocks.length = 0;
		vi.useRealTimers();
	});

	it("subscribeAtom adds res to the per-atom Set (broadcast reaches it)", () => {
		const res = newMock();
		subscribeAtom("a1", res as unknown as express.Response);

		// Initial : connected frame on subscribe
		expect(res.chunks).toContain(": connected\n\n");

		// Broadcast reaches it — proves it was registered in the Set
		broadcastAtomUpdate(makeAtom({ id: "a1" }));
		const atomFrame = res.chunks.find((c) => c.startsWith("event: atom\ndata: "));
		expect(atomFrame).toBeDefined();
		const parsed = JSON.parse((atomFrame as string).slice("event: atom\ndata: ".length));
		expect(parsed.id).toBe("a1");
	});

	it("broadcastAtomUpdate sends frame to all subscribers of that atom", () => {
		const r1 = newMock();
		const r2 = newMock();
		const rOther = newMock();

		subscribeAtom("a1", r1 as unknown as express.Response);
		subscribeAtom("a1", r2 as unknown as express.Response);
		subscribeAtom("a2", rOther as unknown as express.Response);

		broadcastAtomUpdate(makeAtom({ id: "a1" }));

		const r1Atom = r1.chunks.find((c) => c.startsWith("event: atom"));
		const r2Atom = r2.chunks.find((c) => c.startsWith("event: atom"));
		const rOtherAtom = rOther.chunks.find((c) => c.startsWith("event: atom"));

		expect(r1Atom).toBeDefined();
		expect(r2Atom).toBeDefined();
		// rOther subscribed to a2, must NOT receive an a1 broadcast
		expect(rOtherAtom).toBeUndefined();
	});

	it("res.on('close') removes the res from the Set", () => {
		const res = newMock();
		subscribeAtom("a1", res as unknown as express.Response);

		// First broadcast reaches it
		broadcastAtomUpdate(makeAtom({ id: "a1" }));
		const initial = res.chunks.filter((c) => c.startsWith("event: atom"));
		expect(initial).toHaveLength(1);

		// Simulate client disconnect
		res.triggerClose();

		// Second broadcast must NOT reach it
		broadcastAtomUpdate(makeAtom({ id: "a1" }));
		const after = res.chunks.filter((c) => c.startsWith("event: atom"));
		expect(after).toHaveLength(1);
	});

	it("broadcastAtomUpdate with no subscribers is a no-op", () => {
		// Random id guarantees no prior test in this file subscribed to it
		const id = `nonexistent-${Math.random().toString(36).slice(2)}`;
		expect(() => broadcastAtomUpdate(makeAtom({ id }))).not.toThrow();
	});

	it("heartbeat fires : ping frame every SSE_HEARTBEAT_MS", () => {
		vi.useFakeTimers();
		const res = newMock();
		subscribeAtom("a1", res as unknown as express.Response);

		// Initial frame only
		expect(res.chunks).toContain(": connected\n\n");
		expect(res.chunks.some((c) => c === ": ping\n\n")).toBe(false);

		// After one heartbeat interval, exactly one : ping
		vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
		const pings1 = res.chunks.filter((c) => c === ": ping\n\n");
		expect(pings1).toHaveLength(1);

		// After a second interval, exactly two : ping frames
		vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
		const pings2 = res.chunks.filter((c) => c === ": ping\n\n");
		expect(pings2).toHaveLength(2);
	});
});
