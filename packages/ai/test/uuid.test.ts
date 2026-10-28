import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../src/utils/uuid.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = 0x0123456789ab;

function parseTimestamp(uuid: string): number {
	return Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("uuidv7", () => {
	it("generates ordered UUIDv7s while preserving follower timestamps", () => {
		vi.useFakeTimers();
		vi.setSystemTime(TIMESTAMP);

		const first = uuidv7();
		const second = uuidv7();
		vi.setSystemTime(TIMESTAMP - 1);
		const afterRollback = uuidv7();
		vi.setSystemTime(TIMESTAMP + 1);
		const afterAdvance = uuidv7();
		const ordinaryIds = [first, second, afterRollback, afterAdvance];
		const followerTimestamp = TIMESTAMP - 1_000;
		const followers = [uuidv7(followerTimestamp), uuidv7(followerTimestamp)];

		for (const id of [...ordinaryIds, ...followers]) expect(id).toMatch(UUID_V7_RE);
		expect(ordinaryIds).toEqual([...ordinaryIds].sort());
		expect(new Set(ordinaryIds)).toHaveLength(ordinaryIds.length);
		expect(ordinaryIds.map(parseTimestamp)).toEqual([TIMESTAMP, TIMESTAMP, TIMESTAMP, TIMESTAMP + 1]);
		expect(followers.map(parseTimestamp)).toEqual([followerTimestamp, followerTimestamp]);
		expect(new Set(followers)).toHaveLength(followers.length);
	});

	it("uses fresh randomness for every UUID tail", () => {
		let randomByte = 0;
		vi.stubGlobal("crypto", {
			getRandomValues(bytes: Uint8Array) {
				return bytes.fill(++randomByte);
			},
		});

		expect([uuidv7(TIMESTAMP).slice(-8), uuidv7(TIMESTAMP).slice(-8)]).toEqual(["01010101", "02020202"]);
	});

	it.each([0, 2 ** 48 - 1])("accepts timestamp boundary %s", (timestamp) => {
		expect(parseTimestamp(uuidv7(timestamp))).toBe(timestamp);
	});

	it.each([-1, 2 ** 48, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid timestamp %s", (timestamp) => {
		expect(() => uuidv7(timestamp)).toThrow(RangeError);
	});
});
