// Start one private project-browser broker; IPC is used only for its validated startup handshake.
import { Compile } from "typebox/compile";
import { serveProjectBrowser } from "./browser-broker.ts";
import { ProjectBrowserInitSchema } from "./browser-protocol.ts";

const initValidator = Compile(ProjectBrowserInitSchema);
process.once("message", (message: unknown) => {
	void (async () => {
		if (!initValidator.Check(message)) throw new Error("Invalid project browser initialization");
		const broker = await serveProjectBrowser(message, () => process.exit(0));
		for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
			process.once(signal, () => void broker.close().catch(() => process.exit(1)));
		process.send!(broker.metadata, () => process.disconnect());
	})().catch(() => process.exit(1));
});
