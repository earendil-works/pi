// Starts a helper that inherits stdout and stderr, then exits while the helper keeps running.
import { spawn } from "node:child_process";

const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
	stdio: ["ignore", "inherit", "inherit"],
});
console.error(`helper ${helper.pid}`);
helper.unref();
process.exit(0);
