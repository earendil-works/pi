// A forked child for the IPC link test: echoes every message of its parent link, and exits when the link closes.
import process from "node:process";
import { ipcLink } from "../../../../src/next/link/index.ts";

const link = ipcLink(process as unknown as Parameters<typeof ipcLink>[0]);
link.onMessage((message) => {
	if (message[0] === 0xff) process.exit(0);
	link.send(message);
});
link.onClose(() => process.exit(0));
