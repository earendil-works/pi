import { describe, it, expect, beforeEach } from "vitest";
import { checkBashIntentCommon, clearBashIntentBudget } from "../tools.ts";

describe("checkBashIntentCommon — bash guard", () => {
	beforeEach(() => {
		clearBashIntentBudget("t1");
		clearBashIntentBudget("t2");
	});

	it("bash cat → suggests read (guidance, not hard block)", () => {
		const r = checkBashIntentCommon("cat /etc/hostname", "t1");
		expect(r).toBeDefined();
		expect(r).toContain("Prefer read over bash cat");
	});

	it("bash ls → undefined (list removed from BashIntent)", () => {
		const r = checkBashIntentCommon("ls -la /tmp", "t1");
		expect(r).toBeUndefined();
	});

	it("bash find → undefined (find removed from BashIntent)", () => {
		const r = checkBashIntentCommon("find /tmp -name '*.txt'", "t1");
		expect(r).toBeUndefined();
	});

	it("bash grep → undefined (grep removed from BashIntent)", () => {
		const r = checkBashIntentCommon("grep -r foo /tmp", "t1");
		expect(r).toBeUndefined();
	});

	it("bash sed -i → suggests edit", () => {
		const r = checkBashIntentCommon("sed -i 's/foo/bar/' file.txt", "t1");
		expect(r).toBeDefined();
		expect(r).toContain("Prefer edit over bash sed -i");
	});

	it("bash echo > → suggests write", () => {
		const r = checkBashIntentCommon("echo 'x' > file.txt", "t1");
		expect(r).toBeDefined();
		expect(r).toContain("Prefer write over bash echo");
	});

	it("bash unrelated command → returns null/undefined", () => {
		const r = checkBashIntentCommon("ps aux | head", "t1");
		expect(r).toBeUndefined();
	});

	it("bash with pipeline → returns null/undefined (not safe to match)", () => {
		const r = checkBashIntentCommon("cat /etc/hostname | tr a-z A-Z", "t1");
		expect(r).toBeUndefined();
	});

	it("budget blocks after 3 same-intent attempts", () => {
		const a1 = checkBashIntentCommon("cat /a", "t2");
		expect(a1).toBeDefined();
		const b1 = checkBashIntentCommon("cat /a", "t2");
		expect(b1).toBeDefined();
		const a2 = checkBashIntentCommon("cat /a", "t2");
		expect(a2).toContain("Blocked");
	});
});
