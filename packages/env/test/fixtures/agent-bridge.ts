// A pi-env client channel through the fake relay as a daemon command for `Connection`: `node agent-bridge.ts <url>
// serve --token <hex>` opens the channel, sends the pi-env head, and passes the channel's bytes to stdout and stdin's to
// the channel, so a `Connection` with `command: [node, bridge, url]` talks to the agent as it talks to a daemon.

const url = process.argv[2] as string;
const token = process.argv[process.argv.indexOf("--token") + 1] as string;
const socket = new WebSocket(url, "pi-server.client.v2");
socket.binaryType = "arraybuffer";
const queued: Buffer[] = [];
socket.addEventListener("open", () => {
	socket.send(JSON.stringify({ type: "pi-env", token }));
	for (const chunk of queued.splice(0)) socket.send(chunk);
});
socket.addEventListener("message", (event) => {
	process.stdout.write(Buffer.from(event.data as ArrayBuffer));
});
socket.addEventListener("close", (event) => {
	process.stderr.write(`agent-bridge: channel closed (${event.code})\n`);
	process.exit(0);
});
socket.addEventListener("error", () => {
	process.stderr.write("agent-bridge: channel failed\n");
	process.exit(1);
});
process.stdin.on("data", (chunk: Buffer) => {
	if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
	else queued.push(chunk);
});
process.stdin.on("end", () => socket.close(1000));
