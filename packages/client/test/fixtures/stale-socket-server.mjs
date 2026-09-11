import { createServer } from "node:net";

const path = process.argv[2];
if (!path) throw new Error("Socket path argument is required");

const server = createServer();
server.listen(path, () => {
	if (process.send) process.send("listening");
});
