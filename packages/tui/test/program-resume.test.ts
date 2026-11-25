import assert from "node:assert";
import { describe, it } from "node:test";
import { formatProgramResume, formatProgramResumeClear, takeProgramResumeToken } from "../src/program-resume.ts";

// Token, pid and time of the examples in the spec, whose mac values are the real hashes.
const sender = { token: "dummy-token-replace-me", pid: 74877, time: 1795543200 };

describe("formatProgramResume", () => {
	it("matches the spec's Neovim example", () => {
		assert.equal(
			formatProgramResume({ argv: ["nvim", "-S", "/home/user/.local/state/nvim/sessions/8f2c1d.vim"] }, sender),
			"\x1b]7577;pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt:mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b\x1b\\",
		);
	});

	it("matches the spec's lazygit example with a cwd", () => {
		assert.equal(
			formatProgramResume({ argv: ["lazygit"], cwd: "/home/user/src/project" }, sender),
			"\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1\x1b\\",
		);
	});

	it("matches the spec's wrapper example", () => {
		assert.equal(
			formatProgramResume({ argv: ["resume-wrap", "ssh", "devbox"] }, { ...sender, pid: 90412 }),
			"\x1b]7577;pid=90412:time=1795543200:argv=cmVzdW1lLXdyYXA=,c3No,ZGV2Ym94:mac=e76149d0ba54a83570ffab0583867dacdfa23928ba9d18604f0badea88b62b65\x1b\\",
		);
	});

	it("keeps empty arguments after the program", () => {
		assert.match(formatProgramResume({ argv: ["pi", ""] }, sender) ?? "", /:argv=cGk=,:mac=/);
	});

	it("returns undefined for commands the protocol cannot carry", () => {
		const unreportable = [
			{ argv: [] },
			{ argv: [""] },
			{ argv: ["./run.sh"] },
			{ argv: ["bin/pi"] },
			{ argv: ["-pi"] },
			{ argv: ["pi", "line\nbreak"] },
			{ argv: ["pi", "c1\u009bcontrol"] },
			{ argv: ["pi", "lone \ud800 surrogate"] },
			{ argv: ["pi"], cwd: "project" },
			{ argv: ["pi"], cwd: "/tmp/\x1b" },
			{ argv: ["pi", ...Array.from({ length: 64 }, () => "x")] },
			{ argv: ["pi", "x".repeat(2048)] },
		];
		for (const command of unreportable) {
			assert.equal(formatProgramResume(command, sender), undefined, JSON.stringify(command));
		}
		assert.notEqual(formatProgramResume({ argv: ["/usr/local/bin/pi"], cwd: "/" }, sender), undefined);
	});
});

describe("formatProgramResumeClear", () => {
	it("matches the spec's Neovim clear example", () => {
		assert.equal(
			formatProgramResumeClear(sender),
			"\x1b]7577;pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93\x1b\\",
		);
	});
});

describe("takeProgramResumeToken", () => {
	it("returns the token and removes it from the environment", () => {
		const env: NodeJS.ProcessEnv = { OSC7577_TOKEN: "abc", PATH: "/bin" };
		assert.equal(takeProgramResumeToken(env), "abc");
		assert.deepEqual(env, { PATH: "/bin" });
	});

	it("treats a missing or empty token as no support", () => {
		const env: NodeJS.ProcessEnv = { OSC7577_TOKEN: "" };
		assert.equal(takeProgramResumeToken(env), undefined);
		assert.deepEqual(env, {});
		assert.equal(takeProgramResumeToken({}), undefined);
	});
});
