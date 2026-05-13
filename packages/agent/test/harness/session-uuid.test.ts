import { describe, expect, it, vi } from "vitest";

const randomBytesMock = vi.hoisted(() => vi.fn<(size: number) => Buffer>());

vi.mock("node:crypto", () => ({
	randomBytes: randomBytesMock,
}));

import { uuidv7 } from "../../src/harness/session/uuid.js";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = 0x0123456789ab;

function parseTimestamp(uuid: string): number {
	return Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
}

describe("uuidv7", () => {
	it("uses the RFC 9562 layout and preserves monotonic order", () => {
		randomBytesMock
			.mockReturnValueOnce(
				Buffer.from([0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xfe, 0x01, 0x11, 0x22, 0x33, 0x44, 0x55]),
			)
			.mockReturnValueOnce(Buffer.alloc(16))
			.mockReturnValueOnce(Buffer.alloc(16));
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(TIMESTAMP);

		try {
			const first = uuidv7();
			const second = uuidv7();
			const third = uuidv7();

			expect(first).toBe("01234567-89ab-7fff-bfff-f91122334455");
			expect(second).toBe("01234567-89ab-7fff-bfff-fc0000000000");
			expect(third).toBe("01234567-89ac-7000-8000-000000000000");
			expect(first).toMatch(UUID_V7_RE);
			expect(second).toMatch(UUID_V7_RE);
			expect(third).toMatch(UUID_V7_RE);
			expect(parseTimestamp(first)).toBe(TIMESTAMP);
			expect(parseTimestamp(second)).toBe(TIMESTAMP);
			expect(parseTimestamp(third)).toBe(TIMESTAMP + 1);
			expect(first < second).toBe(true);
			expect(second < third).toBe(true);
			expect(randomBytesMock).toHaveBeenCalledTimes(3);
			expect(randomBytesMock).toHaveBeenCalledWith(16);
		} finally {
			dateNow.mockRestore();
		}
	});
});
