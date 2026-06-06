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

describe("validateSatelliteCall — localPathPattern (transfer_file SSRF guard)", () => {
	// Without a localPathPattern in mcp.json, ANY local path is accepted
	// for transfer_file(to_remote). This is the credential-exfil path:
	// a malicious model can ask the agent to read ~/.ssh/id_rsa and ship
	// its bytes over the MCP wire. With localPathPattern set, paths
	// matching the pattern are accepted and others are blocked.

	const guardedConfig = {
		satellite: {
			url: "http://localhost:29001/mcp",
			token: "test",
			remotePathPattern: "/TJPROJ\\d+",
			// Whitelist: only files under ~/projects and /tmp may be sent to remote.
			localPathPattern: "(/home/[^/]+/projects/.*|/tmp/.*)",
		},
	};

	it("local path inside the pattern → no block", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{
				tool: "transfer_file",
				direction: "to_remote",
				file1: "/home/alice/projects/foo/data.txt",
				file2: "/TJPROJ13/data.txt",
			},
			guardedConfig,
			"t-loc-1",
		);
		expect(r).toBeUndefined();
	});

	it("local /tmp path inside the pattern → no block", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{
				tool: "transfer_file",
				direction: "to_remote",
				file1: "/tmp/build/output.bin",
				file2: "/TJPROJ13/output.bin",
			},
			guardedConfig,
			"t-loc-2",
		);
		expect(r).toBeUndefined();
	});

	it("local path outside the pattern (e.g. ~/.ssh) → block (credential exfil prevention)", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{
				tool: "transfer_file",
				direction: "to_remote",
				file1: "/home/alice/.ssh/id_rsa",
				file2: "/TJPROJ13/key",
			},
			guardedConfig,
			"t-loc-3",
		);
		expect(r?.block).toBe(true);
		expect(r?.reason).toContain("outside the allowed local scope");
	});

	it("local /etc path outside the pattern → block", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{
				tool: "transfer_file",
				direction: "to_remote",
				file1: "/etc/shadow",
				file2: "/TJPROJ13/x",
			},
			guardedConfig,
			"t-loc-4",
		);
		expect(r?.block).toBe(true);
	});

	it("no localPathPattern set → no block (back-compat for users who don't opt in)", () => {
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{
				tool: "transfer_file",
				direction: "to_remote",
				file1: "/home/alice/.ssh/id_rsa",
				file2: "/TJPROJ13/key",
			},
			mcpConfig, // original config without localPathPattern
			"t-loc-5",
		);
		expect(r).toBeUndefined();
	});

	it("local path scope applies to to_local too (we don't want to receive untrusted downloads into ~/.ssh)", () => {
		// For to_local, the local_path is the destination. Allowing the
		// agent to write into ~/.ssh/authorized_keys would be a write
		// path-constraint violation, not just a read one. Check the
		// destination pattern too.
		const r = validateSatelliteCall(
			"satellite_remote_exec",
			{
				tool: "transfer_file",
				direction: "to_local",
				file1: "/home/alice/.ssh/authorized_keys",
				file2: "/TJPROJ13/key",
			},
			guardedConfig,
			"t-loc-6",
		);
		expect(r?.block).toBe(true);
	});
});
