import { describe, it, expect } from "vitest";
import { checkBashIntentCommon } from "../tools.ts";

describe("BashIntent narrowed to read|edit|write", () => {
	it("cat → read (still valid)", () => {
		const r = checkBashIntentCommon("cat /etc/hostname", "test", "satellite");
		expect(r).toBeDefined();
		expect(r).toContain("Prefer read over");
	});

	it("sed -i → edit (still valid)", () => {
		const r = checkBashIntentCommon("sed -i 's/foo/bar/' file.txt", "test", "satellite");
		expect(r).toBeDefined();
		expect(r).toContain("Prefer edit over");
	});

	it("echo > → write (still valid)", () => {
		const r = checkBashIntentCommon("echo 'x' > file.txt", "test", "satellite");
		expect(r).toBeDefined();
		expect(r).toContain("Prefer write over");
	});

	it("ls → null (list removed from BashIntent)", () => {
		const r = checkBashIntentCommon("ls -la /tmp", "test", "satellite");
		expect(r).toBeUndefined();
	});

	it("find → null (find removed from BashIntent)", () => {
		const r = checkBashIntentCommon("find /tmp -name '*.txt'", "test", "satellite");
		expect(r).toBeUndefined();
	});

	it("grep → null (grep removed from BashIntent)", () => {
		const r = checkBashIntentCommon("grep -r foo /tmp", "test", "satellite");
		expect(r).toBeUndefined();
	});

	it("pipeline → null (not intercepted regardless)", () => {
		const r = checkBashIntentCommon("cat /etc/hostname | tr a-z A-Z", "test", "satellite");
		expect(r).toBeUndefined();
	});
});
