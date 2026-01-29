import { existsSync } from "fs";
import { dirname, join } from "path";

export function findRepoRoot(startDir: string): string | null {
	let dir = startDir;

	while (true) {
		const gitPath = join(dir, ".git");
		const gitHeadPath = join(gitPath, "HEAD");

		if (existsSync(gitHeadPath) || existsSync(gitPath)) {
			return dir;
		}

		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}
