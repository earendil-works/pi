import type * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	controller: new AbortController(),
	spawn: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn: mocks.spawn,
}));

vi.mock("../src/utils/tools-manager.ts", () => ({
	ensureTool: async () => "fd",
}));

// Abort while find looks for a .git directory above the search path.
vi.mock("../src/core/tools/path-utils.ts", async (importOriginal) => ({
	...(await importOriginal<typeof pathUtils>()),
	pathExists: async (filePath: string) => {
		if (!filePath.endsWith(".git")) return true;
		mocks.controller.abort();
		return false;
	},
}));

import { createFindToolDefinition } from "../src/core/tools/find.ts";
import type * as pathUtils from "../src/core/tools/path-utils.ts";

describe("find abort before fd starts", () => {
	beforeEach(() => {
		mocks.controller = new AbortController();
		mocks.spawn.mockClear();
	});

	it("does not start fd after an abort during the .git lookup", async () => {
		const def = createFindToolDefinition(tmpdir());
		const ctx = {} as Parameters<typeof def.execute>[4];
		await expect(def.execute("call-1", { pattern: "*.ts" }, mocks.controller.signal, undefined, ctx)).rejects.toThrow(
			"Operation aborted",
		);
		// Let the rest of execute() run after the rejection.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
