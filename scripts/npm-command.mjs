import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function execNpmSync(args, options = {}) {
	if (process.platform !== "win32") return execFileSync("npm", args, options);
	const npmCli = process.env.npm_execpath;
	if (!npmCli) throw new Error("Cannot locate npm on Windows. Run this command through its npm script.");
	if (!existsSync(npmCli)) throw new Error(`Cannot locate the npm CLI: ${npmCli}`);
	return execFileSync(process.execPath, [npmCli, ...args], options);
}
