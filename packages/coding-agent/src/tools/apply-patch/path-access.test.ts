import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runApplyPatchEngine } from "./engine.js";

describe("apply-patch engine path access", () => {
	it("allows relative paths to escape cwd (matches Write/Edit behavior)", async () => {
		const root = await mkdtemp(join(tmpdir(), "apply-patch-path-"));
		const sandbox = join(root, "sandbox");
		await mkdir(sandbox, { recursive: true });

		try {
			const patch = ["*** Begin Patch", "*** Add File: ../escape.txt", "+escape", "*** End Patch"].join("\n");

			const result = await runApplyPatchEngine(patch, sandbox);
			expect(result.exitCode).toBe(0);

			const escapedPath = join(root, "escape.txt");
			const contents = await readFile(escapedPath, "utf8");
			expect(contents).toBe("escape\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("follows symlink parent directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "apply-patch-symlink-parent-"));
		const sandbox = join(root, "sandbox");
		const realDir = join(root, "real");
		const linkDir = join(sandbox, "link");

		await mkdir(sandbox, { recursive: true });
		await mkdir(realDir, { recursive: true });

		try {
			try {
				await symlink(realDir, linkDir, "dir");
			} catch (error) {
				// Some environments (notably Windows without admin/developer mode) can't create symlinks.
				// This behavior is best-effort; skip the assertion if we can't create the symlink.
				return;
			}

			const patch = ["*** Begin Patch", "*** Add File: link/through.txt", "+through", "*** End Patch"].join("\n");

			const result = await runApplyPatchEngine(patch, sandbox);
			expect(result.exitCode).toBe(0);

			const contents = await readFile(join(realDir, "through.txt"), "utf8");
			expect(contents).toBe("through\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("updates symlink file targets", async () => {
		const root = await mkdtemp(join(tmpdir(), "apply-patch-symlink-file-"));
		const sandbox = join(root, "sandbox");
		const realFile = join(root, "real.txt");
		const linkFile = join(sandbox, "link.txt");

		await mkdir(sandbox, { recursive: true });

		try {
			await writeFile(realFile, "hello\n", "utf8");

			try {
				await symlink(realFile, linkFile, "file");
			} catch (error) {
				// See note above re: symlink support.
				return;
			}

			const patch = [
				"*** Begin Patch",
				"*** Update File: link.txt",
				"@@",
				"-hello",
				"+hello2",
				"*** End Patch",
			].join("\n");

			const result = await runApplyPatchEngine(patch, sandbox);
			expect(result.exitCode).toBe(0);

			const contents = await readFile(realFile, "utf8");
			expect(contents).toBe("hello2\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
