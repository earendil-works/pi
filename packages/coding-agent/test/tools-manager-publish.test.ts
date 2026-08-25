import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishBinary } from "../src/utils/tools-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("publishBinary", () => {
	it("keeps the binary published by a concurrent installer", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tools-manager-"));
		tempDirs.push(dir);
		const first = join(dir, "first");
		const second = join(dir, "second");
		const target = join(dir, "fd");
		writeFileSync(first, "first");
		writeFileSync(second, "second");

		publishBinary(first, target, "win32");
		publishBinary(second, target, "win32");

		expect(readFileSync(target, "utf8")).toBe("first");
	});
});
