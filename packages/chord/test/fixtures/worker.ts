// Child host for manager tests. FIXTURE_MODE: normal | ignore-shutdown | fatal.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHost, type IpcChannel, ipcLink } from "../../src/index.ts";
import { childControl } from "../../src/manager.ts";
import { Echo } from "./echo.ts";

const mode = process.env.FIXTURE_MODE ?? "normal";
const control = childControl();
if (mode === "fatal") {
	control.fatal(new Error("fixture refuses to start"));
	setTimeout(() => process.exit(1), 200);
} else {
	// Before anything that owns data: the kernel lock (if the manager configured one).
	await control.lock().catch(() => {
		setTimeout(() => process.exit(1), 200);
		return new Promise<never>(() => {});
	});
	const host = createHost({
		self: { kind: "host" },
		name: process.env.HOST_NAME ?? "worker",
		upstream: { link: ipcLink(process as unknown as IpcChannel), principal: { kind: "server" } },
		onError: () => {},
	});
	const init = (await control.init) as { greeting: string };
	host.serve(Echo, () => ({
		variant: "main",
		echo: (text: string) => `${init.greeting} ${text} from ${process.pid}`,
		pid: () => process.pid,
	}));
	if (process.env.GRANDCHILD_FILE) {
		const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		writeFileSync(process.env.GRANDCHILD_FILE, String(grandchild.pid));
	}
	control.onShutdown(async () => {
		if (mode === "ignore-shutdown") return;
		await host.close();
		process.exit(0);
	});
	control.ready();
}
