// Cross-platform file operations for package build scripts, using only Node built-ins.
import { chmodSync, cpSync, globSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const [command, ...paths] = process.argv.slice(2);
const usage = "Usage: package-files.mjs clean <paths...> | copy <sources...> <directory> | executable <files...>";

if (paths.length === 0) throw new Error(usage);

switch (command) {
	case "clean":
		for (const path of paths) rmSync(path, { recursive: true, force: true });
		break;
	case "copy": {
		const destination = paths.pop();
		if (!destination || paths.length === 0) throw new Error(usage);
		mkdirSync(destination, { recursive: true });
		for (const pattern of paths) {
			const sources = globSync(pattern);
			if (sources.length === 0) throw new Error(`No files match ${pattern}`);
			for (const source of sources) cpSync(source, join(destination, basename(source)), { recursive: true });
		}
		break;
	}
	case "executable":
		for (const path of paths) chmodSync(path, statSync(path).mode | 0o111);
		break;
	default:
		throw new Error(usage);
}
