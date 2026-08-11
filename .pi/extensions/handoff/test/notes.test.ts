import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	archiveDir,
	archiveNote,
	ensureGitExclude,
	HANDOFF_SCHEMA,
	type HandoffNote,
	handoffsDir,
	listPendingNotePaths,
	noteFilename,
	parseNote,
	readNote,
	serializeNote,
	writeNote,
} from "../notes.ts";

function sampleNote(overrides: Partial<HandoffNote["frontmatter"]> = {}): HandoffNote {
	return {
		frontmatter: {
			schema: HANDOFF_SCHEMA,
			session_id: "019feda9-55bc-797d-8b97-4fe03f430270",
			session_file: "/Users/kyle/.pi/agent/sessions/--p--/2026-08-10T21-52-05-564Z_019feda9.jsonl",
			cwd: "/Users/kyle/Projects/foo",
			created: "2026-08-10T22:15:00.000Z",
			source: "digest",
			model: "google/gemini-3.6-flash",
			kickoff: "Continue implementing the reader module",
			...overrides,
		},
		body: "## Context\nWhat we were doing.\n\n## Next steps\nWire archive-on-delivery.\n",
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-handoff-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("serialize/parse round-trip", () => {
	it("preserves every frontmatter field and the body", () => {
		const note = sampleNote();
		const parsed = parseNote(serializeNote(note));
		expect(parsed).toEqual(note);
	});

	it("survives a kickoff containing a colon, quotes, and a hash", () => {
		const kickoff = 'Fix: the "reader" module # not a comment';
		const parsed = parseNote(serializeNote(sampleNote({ kickoff })));
		expect(parsed?.frontmatter.kickoff).toBe(kickoff);
	});

	it("survives a kickoff containing a newline", () => {
		const kickoff = "First line\nSecond line";
		const parsed = parseNote(serializeNote(sampleNote({ kickoff })));
		expect(parsed?.frontmatter.kickoff).toBe(kickoff);
	});

	it("keeps a body that contains its own --- separators", () => {
		const note = sampleNote();
		note.body = "## Context\n\n---\n\nA horizontal rule above.\n";
		const parsed = parseNote(serializeNote(note));
		expect(parsed?.body).toBe(note.body);
	});

	it("omits optional fields that are absent", () => {
		const note = sampleNote();
		delete note.frontmatter.model;
		delete note.frontmatter.session_file;
		const text = serializeNote(note);
		expect(text).not.toContain("model:");
		expect(text).not.toContain("session_file:");
		expect(parseNote(text)).toEqual(note);
	});

	it("emits plain scalars for ordinary values", () => {
		expect(serializeNote(sampleNote())).toContain("created: 2026-08-10T22:15:00.000Z");
	});

	it("emits frontmatter in the documented key order", () => {
		const keys = serializeNote(sampleNote())
			.split("\n")
			.slice(1, 9)
			.map((line) => line.split(":")[0]);
		expect(keys).toEqual(["schema", "session_id", "session_file", "cwd", "created", "source", "model", "kickoff"]);
	});
});

describe("parseNote rejection", () => {
	it("rejects a file with no frontmatter", () => {
		expect(parseNote("just a body\n")).toBeUndefined();
	});

	it("rejects unterminated frontmatter", () => {
		expect(parseNote(`---\nschema: ${HANDOFF_SCHEMA}\nsession_id: a\n`)).toBeUndefined();
	});

	it("rejects an unknown schema", () => {
		expect(parseNote(serializeNote(sampleNote({ schema: "pi-handoff/v2" })))).toBeUndefined();
	});

	it("rejects an unknown source", () => {
		const text = serializeNote(sampleNote()).replace("source: digest", "source: telepathy");
		expect(parseNote(text)).toBeUndefined();
	});

	it("rejects a malformed frontmatter line", () => {
		const text = serializeNote(sampleNote()).replace("cwd: ", "cwd ");
		expect(parseNote(text)).toBeUndefined();
	});

	it("defaults a missing kickoff rather than discarding the note", () => {
		const text = serializeNote(sampleNote()).replace(/^kickoff:.*\n/m, "");
		expect(parseNote(text)?.frontmatter.kickoff).toBe("");
	});
});

describe("noteFilename", () => {
	it("mirrors pi session-file naming and truncates the session id", () => {
		expect(noteFilename("2026-08-10T22:15:00.000Z", "019feda9-55bc-797d")).toBe(
			"2026-08-10T22-15-00-000Z_019feda9.md",
		);
	});
});

describe("writeNote / listPendingNotePaths", () => {
	it("writes into .pi/handoffs and reads back identically", () => {
		const note = sampleNote();
		const path = writeNote(dir, note);
		expect(path).toBe(join(handoffsDir(dir), noteFilename(note.frontmatter.created, note.frontmatter.session_id)));
		expect(readNote(path)).toEqual(note);
	});

	it("returns an empty list when the directory does not exist", () => {
		expect(listPendingNotePaths(dir)).toEqual([]);
	});

	it("sorts oldest first and ignores archive/ and .tmp leftovers", () => {
		writeNote(dir, sampleNote({ created: "2026-08-10T22:15:00.000Z", session_id: "bbbbbbbb" }));
		writeNote(dir, sampleNote({ created: "2026-08-09T10:00:00.000Z", session_id: "aaaaaaaa" }));
		mkdirSync(archiveDir(dir), { recursive: true });
		writeFileSync(join(archiveDir(dir), "2026-01-01T00-00-00-000Z_cccccccc.md"), "archived");
		writeFileSync(join(handoffsDir(dir), "2026-08-11T00-00-00-000Z_dddddddd.md.tmp"), "half-written");

		expect(listPendingNotePaths(dir).map((p) => p.split("/").pop())).toEqual([
			"2026-08-09T10-00-00-000Z_aaaaaaaa.md",
			"2026-08-10T22-15-00-000Z_bbbbbbbb.md",
		]);
	});

	it("leaves no .tmp file behind after a write", () => {
		const path = writeNote(dir, sampleNote());
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});
});

describe("ensureGitExclude", () => {
	const excludeOf = (repo: string) => join(repo, ".git", "info", "exclude");
	/**
	 * A git environment isolated from the developer's ignore rules, so these assertions test
	 * `ensureGitExclude` and nothing else. Each of the three pieces closes a different door,
	 * and all three are needed: `GIT_CONFIG_NOSYSTEM` suppresses /etc/gitconfig,
	 * `GIT_CONFIG_GLOBAL=/dev/null` suppresses ~/.gitconfig, and `-c core.excludesFile=/dev/null`
	 * suppresses the excludes file itself — which the first two do *not* reach, because unsetting
	 * `core.excludesFile` is exactly the condition under which git falls back to its default,
	 * `$XDG_CONFIG_HOME/git/ignore` (`~/.config/git/ignore`). Left open, a `*.md` rule there makes
	 * the positive assertions pass no matter what was written and a `.pi/` rule fails the negative
	 * one on correct code. The GIT_DIR family is cleared so a run under a git hook or
	 * `git rebase --exec` cannot aim git at the outer repo.
	 */
	const gitEnv = (): NodeJS.ProcessEnv => {
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
		delete env.GIT_DIR;
		delete env.GIT_WORK_TREE;
		delete env.GIT_INDEX_FILE;
		return env;
	};
	const git = (repo: string, ...args: string[]) =>
		spawnSync("git", ["-c", "core.excludesFile=/dev/null", ...args], { cwd: repo, env: gitEnv(), encoding: "utf8" });
	/** `git check-ignore` exits 1 for a path that is not ignored. */
	const isIgnored = (repo: string, relativePath: string) => git(repo, "check-ignore", relativePath).status === 0;

	/**
	 * Guards the isolation the docblock above claims, by running the real helper against a
	 * hostile `~/.config/git/ignore`. Drop any one of the three pieces and this fails, instead
	 * of every positive assertion below quietly passing on whatever was written.
	 */
	it("is isolated from the developer's global excludes file", () => {
		const home = join(dir, "fake-home");
		mkdirSync(join(home, ".config", "git"), { recursive: true });
		writeFileSync(join(home, ".config", "git", "ignore"), "*.md\n");

		const repo = join(dir, "repo");
		mkdirSync(join(repo, ".pi", "handoffs"), { recursive: true });
		writeFileSync(join(repo, ".pi", "handoffs", "note.md"), "x");

		// gitEnv() spreads process.env, so pointing HOME here is what reaches the helper.
		const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
		process.env.HOME = home;
		process.env.XDG_CONFIG_HOME = join(home, ".config");
		try {
			expect(git(repo, "init", "-q").status).toBe(0);
			// No ensureGitExclude call: nothing has written an entry, so the only thing that
			// could report this path as ignored is a rule leaking in from outside the test.
			expect(isIgnored(repo, ".pi/handoffs/note.md")).toBe(false);
		} finally {
			if (saved.home === undefined) delete process.env.HOME;
			else process.env.HOME = saved.home;
			if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = saved.xdg;
		}
	});

	it("does nothing outside a git repo", () => {
		ensureGitExclude(dir);
		expect(existsSync(join(dir, ".git"))).toBe(false);
	});

	it("appends the entry, creating info/exclude when absent", () => {
		mkdirSync(join(dir, ".git"), { recursive: true });
		ensureGitExclude(dir);

		const contents = readFileSync(excludeOf(dir), "utf8");
		expect(contents).toContain(".pi/handoffs/");
		expect(contents).toContain("# pi session handoff notes (local only)");
		// Never all of .pi/, which some repos track.
		expect(contents.split("\n").some((line) => line.trim() === ".pi/")).toBe(false);
	});

	it("is idempotent", () => {
		mkdirSync(join(dir, ".git", "info"), { recursive: true });
		writeFileSync(excludeOf(dir), "# git ls-files --others --exclude-from=.git/info/exclude\nbuild/\n");
		ensureGitExclude(dir);
		const once = readFileSync(excludeOf(dir), "utf8");
		ensureGitExclude(dir);

		expect(readFileSync(excludeOf(dir), "utf8")).toBe(once);
		expect(once).toContain("build/");
		expect(once.match(/\.pi\/handoffs\//g)).toHaveLength(1);
	});

	it("recognises an existing entry written without a trailing slash", () => {
		mkdirSync(join(dir, ".git", "info"), { recursive: true });
		writeFileSync(excludeOf(dir), "**/.pi/handoffs\n");
		ensureGitExclude(dir);
		expect(readFileSync(excludeOf(dir), "utf8")).toBe("**/.pi/handoffs\n");
	});

	it("does not glue the entry onto an unterminated last line", () => {
		mkdirSync(join(dir, ".git", "info"), { recursive: true });
		writeFileSync(excludeOf(dir), "build/");
		ensureGitExclude(dir);
		expect(readFileSync(excludeOf(dir), "utf8").split("\n")[0]).toBe("build/");
	});

	it("actually ignores notes, from the repo root and from a subdirectory", () => {
		// Asserts ignore-status via git itself, not the presence of a string: a pattern with
		// a mid-string separator is anchored to the repo root, so a bare `.pi/handoffs/`
		// passes a substring check while leaving subdirectory notes untracked-and-visible.
		const repo = join(dir, "repo");
		mkdirSync(repo, { recursive: true });
		expect(git(repo, "init", "-q").status).toBe(0);

		const nested = join(repo, "packages", "thing");
		mkdirSync(join(nested, ".pi", "handoffs"), { recursive: true });
		mkdirSync(join(repo, ".pi", "handoffs"), { recursive: true });
		writeFileSync(join(repo, ".pi", "handoffs", "root.md"), "x");
		writeFileSync(join(nested, ".pi", "handoffs", "nested.md"), "x");

		ensureGitExclude(nested);

		expect(isIgnored(repo, ".pi/handoffs/root.md")).toBe(true);
		expect(isIgnored(repo, "packages/thing/.pi/handoffs/nested.md")).toBe(true);
	});

	it("never excludes all of .pi, which some repos track", () => {
		const repo = join(dir, "repo");
		mkdirSync(repo, { recursive: true });
		expect(git(repo, "init", "-q").status).toBe(0);
		mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(repo, ".pi", "extensions", "thing.ts"), "x");

		ensureGitExclude(repo);
		expect(isIgnored(repo, ".pi/extensions/thing.ts")).toBe(false);
	});

	it("adds the working pattern to a repo carrying only the old root-anchored one", () => {
		mkdirSync(join(dir, ".git", "info"), { recursive: true });
		writeFileSync(excludeOf(dir), ".pi/handoffs/\n");
		ensureGitExclude(dir);
		expect(readFileSync(excludeOf(dir), "utf8")).toContain("**/.pi/handoffs/");
	});

	it("follows a .git file to the real git dir, as in worktrees and submodules", () => {
		const gitDir = join(dir, "real-git-dir");
		mkdirSync(gitDir, { recursive: true });
		const workTree = join(dir, "worktree");
		mkdirSync(workTree, { recursive: true });
		writeFileSync(join(workTree, ".git"), `gitdir: ${gitDir}\n`);

		ensureGitExclude(workTree);
		expect(readFileSync(join(gitDir, "info", "exclude"), "utf8")).toContain(".pi/handoffs/");
	});

	it("writes to the shared common dir when the worktree declares one", () => {
		const commonDir = join(dir, "main.git");
		mkdirSync(commonDir, { recursive: true });
		const linkedGitDir = join(commonDir, "worktrees", "feature");
		mkdirSync(linkedGitDir, { recursive: true });
		writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
		const workTree = join(dir, "feature");
		mkdirSync(workTree, { recursive: true });
		writeFileSync(join(workTree, ".git"), `gitdir: ${linkedGitDir}\n`);

		ensureGitExclude(workTree);
		expect(readFileSync(join(commonDir, "info", "exclude"), "utf8")).toContain(".pi/handoffs/");
		expect(existsSync(join(linkedGitDir, "info", "exclude"))).toBe(false);
	});

	it("runs as part of writing a note", () => {
		mkdirSync(join(dir, ".git"), { recursive: true });
		writeNote(dir, sampleNote());
		expect(readFileSync(excludeOf(dir), "utf8")).toContain(".pi/handoffs/");
	});
});

describe("archiveNote", () => {
	it("moves the note into archive/ and stamps it", () => {
		const path = writeNote(dir, sampleNote());
		const stamped = archiveNote(dir, path, { consumed_by: "successor-id", consumed_at: "2026-08-11T09:00:00.000Z" });

		expect(stamped).toBe(true);
		expect(existsSync(path)).toBe(false);
		const archived = readNote(join(archiveDir(dir), path.split("/").pop() as string));
		expect(archived?.frontmatter.consumed_by).toBe("successor-id");
		expect(archived?.frontmatter.consumed_at).toBe("2026-08-11T09:00:00.000Z");
		expect(archived?.body).toBe(sampleNote().body);
	});

	it("returns false when another session already claimed the note", () => {
		const path = writeNote(dir, sampleNote());
		expect(archiveNote(dir, path, { consumed_by: "first" })).toBe(true);
		expect(archiveNote(dir, path, { consumed_by: "second" })).toBe(false);
		expect(readNote(join(archiveDir(dir), path.split("/").pop() as string))?.frontmatter.consumed_by).toBe("first");
	});

	it("still archives a note whose frontmatter cannot be parsed", () => {
		mkdirSync(handoffsDir(dir), { recursive: true });
		const path = join(handoffsDir(dir), "2026-08-10T22-15-00-000Z_corrupt0.md");
		writeFileSync(path, "not a note");

		expect(archiveNote(dir, path, { superseded_by: "newer.md" })).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(join(archiveDir(dir), "2026-08-10T22-15-00-000Z_corrupt0.md"), "utf8")).toBe("not a note");
	});
});
