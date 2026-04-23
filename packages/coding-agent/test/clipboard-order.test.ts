import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track call order across stdout writes and native setText.
const calls: { kind: "native" | "osc52" | "pbcopy"; at: number }[] = [];

vi.mock("../src/utils/clipboard-native.js", () => ({
	clipboard: {
		setText: vi.fn(async (_text: string) => {
			// Simulate native addon's NSPasteboard write taking a few ms.
			await new Promise((r) => setTimeout(r, 5));
			calls.push({ kind: "native", at: performance.now() });
		}),
	},
}));

vi.mock("child_process", () => ({
	execSync: vi.fn((cmd: string) => {
		if (cmd === "pbcopy") {
			calls.push({ kind: "pbcopy", at: performance.now() });
		}
	}),
	spawn: vi.fn(),
}));

vi.mock("../src/utils/clipboard-image.js", () => ({
	isWaylandSession: () => false,
}));

let originalWrite: typeof process.stdout.write;

beforeEach(() => {
	calls.length = 0;
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => {
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			calls.push({ kind: "osc52", at: performance.now() });
		}
		return true;
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.clearAllMocks();
});

describe("copyToClipboard ordering", () => {
	it("awaits native setText before emitting OSC 52 (no race)", async () => {
		const { copyToClipboard } = await import("../src/utils/clipboard.js");
		await copyToClipboard("hello");

		const native = calls.findIndex((c) => c.kind === "native");
		const osc52 = calls.findIndex((c) => c.kind === "osc52");
		expect(native).toBeGreaterThanOrEqual(0);
		expect(osc52).toBeGreaterThanOrEqual(0);
		expect(native).toBeLessThan(osc52);
	});

	it("skips pbcopy when native succeeded (preserves original optimization)", async () => {
		const { copyToClipboard } = await import("../src/utils/clipboard.js");
		await copyToClipboard("hello");

		expect(calls.some((c) => c.kind === "native")).toBe(true);
		expect(calls.some((c) => c.kind === "pbcopy")).toBe(false);
	});

	it("still emits OSC 52 even when native succeeded (SSH/mosh correctness)", async () => {
		const { copyToClipboard } = await import("../src/utils/clipboard.js");
		await copyToClipboard("hello");

		expect(calls.some((c) => c.kind === "osc52")).toBe(true);
	});
});
