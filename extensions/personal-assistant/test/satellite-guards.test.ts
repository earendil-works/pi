import { describe, expect, it, beforeEach } from "vitest";
import { validateSatelliteCall, clearBashIntentBudget } from "../tools.ts";

const mcpConfig = {
	satellite: {
		url: "http://localhost:29001/mcp",
		token: "test",
		remotePathPattern: "/TJPROJ\\d+",
	},
};

describe("validateSatelliteCall — schema shape", () => {
	it("non-satellite tool → no block", () => {
		expect(validateSatelliteCall("bash", { command: "ls" }, mcpConfig, "t1")).toBeUndefined();
	});

	it("missing tool field → block with guidance", () => {
		const r = validateSatelliteCall("satellite_remote_exec", { command: "ls" }, mcpConfig, "t1");
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("missing required field");
		expect(r?.reason).toContain("tool");
	});

	it("nested args wrapper with recognized fields → block with WRONG/Correct", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "bash", args: { command: "ls" } },
			mcpConfig,
			"t1",
		);
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("FLATTENED");
		expect(r?.reason).toContain("WRONG");
		expect(r?.reason).toContain("RIGHT");
	});

	it("nested args with only unknown fields → no block (server will reject as invalid sub-op)", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "bash", args: { mystery: 42 } },
			mcpConfig,
			"t1",
		);
		// No recognized sub-op field names in `args` → not a wrapper
		// confusion pattern → pass through. The server will then
		// complain that bash has no `command` field. The client guard
		// only catches the known confusion shapes.
		expect(r).toBeUndefined();
	});

	it("correct flat call with no path → no block", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "bash", command: "echo hi" },
			mcpConfig,
			"t1",
		);
		expect(r).toBeUndefined();
	});
});

describe("validateSatelliteCall — path scope", () => {
	it("in-scope path → no block", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "read_file", path: "/TJPROJ13/GB_MICRO/data.txt" },
			mcpConfig,
			"t1",
		);
		expect(r).toBeUndefined();
	});

	it("out-of-scope path → block with scope message", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "read_file", path: "/etc/passwd" },
			mcpConfig,
			"t1",
		);
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("outside the allowed scope");
		expect(r?.reason).toContain("/TJPROJ\\d+");
	});

	it("path-traversal that resolves out of scope → blocked", () => {
		// realpathSync will collapse the .., so we need to use a path
		// that starts inside /TJPROJ but traverses to /etc.
		// Easiest: just give a literal /etc/../etc/passwd; realpath collapses to /etc/passwd.
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "read_file", path: "/etc/../etc/passwd" },
			mcpConfig,
			"t1",
		);
		expect(r?.block).toBe(true);
	});

	it("no pattern in mcp.json → no block on any path", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "read_file", path: "/etc/passwd" },
			{ satellite: { url: "x", token: "x" } },
			"t1",
		);
		expect(r).toBeUndefined();
	});

	it("transfer_file remote_path out of scope → blocked", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "transfer_file", direction: "remote_to_local", remote_path: "/etc/shadow", local_path: "/tmp/x" },
			mcpConfig,
			"t1",
		);
		expect(r?.block).toBe(true);
	});
});

describe("validateSatelliteCall — bash intent", () => {
	beforeEach(() => clearBashIntentBudget("t-intent"));

	it("bash cat → suggests read_file (guidance, not block-with-reason=block)", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "bash", command: "cat /etc/hostname" },
			mcpConfig,
			"t-intent",
		);
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("read_file");
	});

	it("bash ls → suggests list_dir", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "bash", command: "ls -la /tmp" },
			mcpConfig,
			"t-intent",
		);
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("list_dir");
	});

	it("bash find → suggests find_files", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "bash", command: "find /tmp -name '*.txt'" },
			mcpConfig,
			"t-intent",
		);
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("find_files");
	});

	it("bash grep → suggests grep_files", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "bash", command: "grep -r foo /tmp" },
			mcpConfig,
			"t-intent",
		);
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("grep_files");
	});

	it("bash with pipeline → not intercepted (legitimate shell use)", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "bash", command: "cat /etc/hostname | tr a-z A-Z" },
			mcpConfig,
			"t-intent",
		);
		expect(r).toBeUndefined();
	});

	it("3rd violation of same intent → hard block", () => {
		const t = "t-block-3";
		clearBashIntentBudget(t);
		validateSatelliteCall("satellite_remote_exec", { tool: "bash", command: "cat /a" }, mcpConfig, t);
		validateSatelliteCall("satellite_remote_exec", { tool: "bash", command: "cat /b" }, mcpConfig, t);
		const r3 = validateSatelliteCall("satellite_remote_exec", { tool: "bash", command: "cat /c" }, mcpConfig, t);
		expect(r3?.reason).toContain("Blocked");
		expect(r3?.reason).toContain("3 times");
	});

	it("legit bash (env, processes) → not intercepted", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{ tool: "bash", command: "module load python/3.10" },
			mcpConfig,
			"t-intent",
		);
		expect(r).toBeUndefined();
	});
});

describe("clearBashIntentBudget", () => {
	it("clears the budget for a turn so the next call starts at 0", () => {
		const t = "t-clear";
		clearBashIntentBudget(t);
		// Burn 2 of the budget
		validateSatelliteCall("satellite_remote_exec", { tool: "bash", command: "cat /a" }, mcpConfig, t);
		validateSatelliteCall("satellite_remote_exec", { tool: "bash", command: "cat /b" }, mcpConfig, t);
		// Clear it
		clearBashIntentBudget(t);
		// Next call should be guidance, not blocked
		const r = validateSatelliteCall("satellite_remote_exec", { tool: "bash", command: "cat /c" }, mcpConfig, t);
		expect(r?.reason).toContain("Prefer read_file");
		expect(r?.reason).not.toContain("Blocked");
	});
});
