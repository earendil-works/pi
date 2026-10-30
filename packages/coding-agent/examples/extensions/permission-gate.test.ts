import { describe, expect, it } from "vitest";
import { dangerousCommandReason } from "./permission-gate.ts";

describe("dangerousCommandReason", () => {
	it("flags recursive rm in any flag spelling", () => {
		for (const command of [
			"rm -rf /x",
			"rm -r /x",
			"rm -fr /x",
			"rm -R /x",
			'rm "-rf" /x',
			"rm -r -f /x",
			"rm --recursive --force /x",
			"/bin/rm -rf /x",
		]) {
			expect(dangerousCommandReason(command)).toBe("rm with recursive flag");
		}
	});

	it("does not flag non-recursive rm or the -- terminator", () => {
		for (const command of ["rm -f /x", "rm file", "rm -- -rf"]) {
			expect(dangerousCommandReason(command)).toBeUndefined();
		}
	});

	it("unwraps wrappers to the real command", () => {
		expect(dangerousCommandReason('sh -c "rm -rf /x"')).toBe("rm with recursive flag");
		expect(dangerousCommandReason("sudo -u root rm -rf /x")).toBe("rm with recursive flag");
		expect(dangerousCommandReason("command rm -rf /x")).toBe("rm with recursive flag");
		expect(dangerousCommandReason("env FOO=bar rm -rf /x")).toBe("rm with recursive flag");
		expect(dangerousCommandReason("nice -n 5 rm -rf /x")).toBe("rm with recursive flag");
		expect(dangerousCommandReason("sh script.sh")).toBeUndefined();
		expect(dangerousCommandReason("command -v rm")).toBeUndefined();
		expect(dangerousCommandReason("env")).toBeUndefined();
	});

	it("flags sudo alone as privilege elevation", () => {
		expect(dangerousCommandReason("sudo ls /root")).toBe("sudo (privilege elevation)");
		expect(dangerousCommandReason("sudo")).toBe("sudo shell (no command)");
	});

	it("does not flag benign mentions of dangerous commands", () => {
		expect(dangerousCommandReason('echo "do not run rm -rf /"')).toBeUndefined();
		expect(dangerousCommandReason("ls /tmp")).toBeUndefined();
		expect(dangerousCommandReason("git status")).toBeUndefined();
	});

	it("flags destructive commands beyond rm", () => {
		expect(dangerousCommandReason("find /x -delete")).toBe("find deleting files");
		expect(dangerousCommandReason("find /x -exec rm -rf {} \\;")).toBe("find deleting files");
		expect(dangerousCommandReason("dd if=/dev/zero of=/dev/sda")).toBe("dd with of= target");
		expect(dangerousCommandReason("mkfs.ext4 /dev/sda1")).toBe("mkfs filesystem creation");
		expect(dangerousCommandReason("chmod 777 file")).toBe("chmod/chown 777");
		expect(dangerousCommandReason("chmod u=rwx,g=rwx,o=rwx file")).toBe("chmod/chown 777");
		expect(dangerousCommandReason("git clean -fdx")).toBe("git clean -f");
		expect(dangerousCommandReason("git clean -n")).toBeUndefined();
		expect(dangerousCommandReason("chmod +x file")).toBeUndefined();
	});

	it("checks command substitution bodies", () => {
		expect(dangerousCommandReason("echo $(rm -rf /x)")).toBe("rm with recursive flag");
		expect(dangerousCommandReason("echo `rm -rf /x`")).toBe("rm with recursive flag");
	});

	it("flags a dangerous segment anywhere in a chain", () => {
		expect(dangerousCommandReason("ls && rm -rf /x")).toBe("rm with recursive flag");
		expect(dangerousCommandReason("ls; echo hi")).toBeUndefined();
	});
});
