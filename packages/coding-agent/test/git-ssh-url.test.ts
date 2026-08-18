import { describe, expect, it } from "vitest";
import { parseGitUrl } from "../src/utils/git.ts";

describe("Git URL Parsing", () => {
	describe("protocol URLs (accepted without git: prefix)", () => {
		it("should parse HTTPS URL", () => {
			const result = parseGitUrl("https://github.com/user/repo");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
			});
		});

		it("should parse ssh:// URL", () => {
			const result = parseGitUrl("ssh://git@github.com/user/repo");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "ssh://git@github.com/user/repo",
			});
		});

		it("should parse protocol URL with ref", () => {
			const result = parseGitUrl("https://github.com/user/repo@v1.0.0");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				ref: "v1.0.0",
				repo: "https://github.com/user/repo",
			});
		});
	});

	describe("shorthand URLs (accepted only with git: prefix)", () => {
		it("should parse git@host:path with git: prefix", () => {
			const result = parseGitUrl("git:git@github.com:user/repo");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "git@github.com:user/repo",
			});
		});

		it("should parse host/path shorthand with git: prefix", () => {
			const result = parseGitUrl("git:github.com/user/repo");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
			});
		});

		it("should parse shorthand with ref and git: prefix", () => {
			const result = parseGitUrl("git:git@github.com:user/repo@v1.0.0");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				ref: "v1.0.0",
				repo: "git@github.com:user/repo",
			});
		});
	});

	it("should reject unsafe git install path inputs", () => {
		for (const source of [
			"git:git@evil.example:../../victim/repo",
			"https://evil.example/..%2F..%2Fvictim/repo",
			"https://evil.example/..%2F..%2Fvictim/repo%",
			"git:git@evil.example:/absolute/repo",
			"git:git@evil.example:user\\repo/name",
			"git:git@evil.example:user/repo\0name",
		]) {
			expect(parseGitUrl(source)).toBeNull();
		}
	});

	describe("unsupported without git: prefix", () => {
		it("should reject git@host:path without git: prefix", () => {
			expect(parseGitUrl("git@github.com:user/repo")).toBeNull();
		});

		it("should reject host/path shorthand without git: prefix", () => {
			expect(parseGitUrl("github.com/user/repo")).toBeNull();
		});

		it("should reject user/repo shorthand", () => {
			expect(parseGitUrl("user/repo")).toBeNull();
		});
	});
});
