import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../../../src/core/tools/find.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/12066
 *
 * fd matches --full-path globs against the absolute path, and `find` prefixed path patterns with
 * `**\/`. A pattern could therefore match through folders above the search path: with the project
 * in `.../src/app`, `src/**\/*.ts` returned every `.ts` file in the project. Path patterns are now
 * anchored at the search path, like grep's glob.
 */
describe("issue #12066 find path globs do not match above the search path", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-12066-")));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	function createProject(root: string): void {
		for (const dir of ["src", "lib", "test", "pkg/src"]) mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, "src", "a.ts"), "");
		writeFileSync(join(root, "lib", "b.ts"), "");
		writeFileSync(join(root, "test", "c.ts"), "");
		writeFileSync(join(root, "pkg", "src", "d.ts"), "");
	}

	async function runFind(searchPath: string, pattern: string): Promise<string[]> {
		const def = createFindToolDefinition(searchPath);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = await def.execute("call-1", { pattern }, undefined, undefined, ctx);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		if (text === "No files found matching pattern") return [];
		return text.split("\n").sort();
	}

	it("does not match through an ancestor folder with the same name", async () => {
		const project = join(tempRoot, "src", "app");
		createProject(project);

		expect(await runFind(project, "src/**/*.ts")).toEqual(["src/a.ts"]);
		expect(await runFind(project, "app/**/*.ts")).toEqual([]);
	});

	it("anchors path patterns at the search path; a leading **/ matches at any depth", async () => {
		const project = join(tempRoot, "src", "app");
		createProject(project);

		expect(await runFind(project, "src/*.ts")).toEqual(["src/a.ts"]);
		expect(await runFind(project, "./src/*.ts")).toEqual(["src/a.ts"]);
		expect(await runFind(project, "pkg/src/*.ts")).toEqual(["pkg/src/d.ts"]);
		expect(await runFind(project, "**/src/*.ts")).toEqual(["pkg/src/d.ts", "src/a.ts"]);
		expect(await runFind(project, "**/src/**/*.ts")).toEqual(["pkg/src/d.ts", "src/a.ts"]);
		// Basename and absolute patterns are unchanged.
		expect(await runFind(project, "*.ts")).toEqual(["lib/b.ts", "pkg/src/d.ts", "src/a.ts", "test/c.ts"]);
		const absolute = `${project.replaceAll("\\", "/")}/lib/*.ts`;
		expect(await runFind(project, absolute)).toEqual(["lib/b.ts"]);
	});

	it("treats glob characters in the search path literally", async () => {
		// `*` and `?` are not allowed in Windows file names.
		const name = process.platform === "win32" ? "w[1]{x,y}" : "w*?[1]{x,y}";
		const project = join(tempRoot, name, "src");
		createProject(project);

		expect(await runFind(project, "src/*.ts")).toEqual(["src/a.ts"]);
	});

	it("keeps smart case when the search path has upper-case letters", async () => {
		const project = join(tempRoot, "Upper");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(join(project, "src", "A.ts"), "");
		writeFileSync(join(project, "src", "b.ts"), "");

		expect(await runFind(project, "src/a.ts")).toEqual(["src/A.ts"]);
		expect(await runFind(project, "src/B.ts")).toEqual([]);
	});

	it("works through a symlinked search path", async () => {
		const project = join(tempRoot, "src", "app");
		createProject(project);
		const link = join(tempRoot, "src", "link");
		// A junction on Windows needs no extra privileges; the type is ignored elsewhere.
		symlinkSync(project, link, "junction");

		expect(await runFind(link, "src/**/*.ts")).toEqual(["src/a.ts"]);
	});
});
