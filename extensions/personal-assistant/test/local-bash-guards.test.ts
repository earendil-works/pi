import { describe, it, expect, beforeEach } from "vitest";
import { checkBashIntentCommon, clearBashIntentBudget } from "../tools.ts";

describe("checkBashIntentCommon — local bash", () => {
	beforeEach(() => {
		clearBashIntentBudget("t1");
		clearBashIntentBudget("t2");
	});

	it("bash cat → suggests read (guidance, not hard block)", () => {
		const r = checkBashIntentCommon("cat /etc/hostname", "t1", "local");
		expect(r).toBeDefined();
		expect(r).toContain("Prefer read over bash cat");
	});

	it("bash ls → undefined (list removed from BashIntent)", () => {
		const r = checkBashIntentCommon("ls -la /tmp", "t1", "local");
		expect(r).toBeUndefined();
	});

	it("bash find → undefined (find removed from BashIntent)", () => {
		const r = checkBashIntentCommon("find /tmp -name '*.txt'", "t1", "local");
		expect(r).toBeUndefined();
	});

	it("bash grep → undefined (grep removed from BashIntent)", () => {
		const r = checkBashIntentCommon("grep -r foo /tmp", "t1", "local");
		expect(r).toBeUndefined();
	});

	it("bash sed -i → suggests edit", () => {
		const r = checkBashIntentCommon("sed -i 's/foo/bar/' file.txt", "t1", "local");
		expect(r).toBeDefined();
		expect(r).toContain("Prefer edit over bash sed -i");
	});

	it("bash echo > → suggests write", () => {
		const r = checkBashIntentCommon("echo 'x' > file.txt", "t1", "local");
		expect(r).toBeDefined();
		expect(r).toContain("Prefer write over bash echo");
	});

	it("bash unrelated command → returns null/undefined", () => {
		const r = checkBashIntentCommon("ps aux | head", "t1", "local");
		expect(r).toBeUndefined();
	});

	it("bash with pipeline → returns null/undefined (not safe to match)", () => {
		const r = checkBashIntentCommon("cat /etc/hostname | tr a-z A-Z", "t1", "local");
		expect(r).toBeUndefined();
	});

	it("local and satellite budgets are independent", () => {
		const a1 = checkBashIntentCommon("cat /a", "t2", "local");
		const b1 = checkBashIntentCommon("cat /a", "t2", "satellite");
		expect(a1).toBeDefined();
		expect(b1).toBeDefined();
		// 各自 2 次后第 3 次硬拦截
		const a2 = checkBashIntentCommon("cat /a", "t2", "local");
		const a3 = checkBashIntentCommon("cat /a", "t2", "local");
		expect(a3).toContain("Blocked");
		// satellite 还没到 3 次
		const b2 = checkBashIntentCommon("cat /a", "t2", "satellite");
		expect(b2).not.toContain("Blocked");
	});
});
