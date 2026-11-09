// Thin Rex terminal frontend: only frames and input cross the channel; no session transcript is saved.
import { readFileSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { localProof, receivePackets, sendPacket, verifyLocalProof } from "../local-channel.ts";
import { PaneCredentialsSchema, PaneOutputSchema } from "./protocol.ts";

const credentialsValidator = Compile(PaneCredentialsSchema);
const outputValidator = Compile(PaneOutputSchema);

/** Run an authenticated terminal viewer, restoring terminal state when its owning pi closes it. */
export async function runPaneClient(credentialPath: string): Promise<void> {
	const credentials: unknown = JSON.parse(readFileSync(credentialPath, "utf8"));
	if (!credentialsValidator.Check(credentials)) throw new Error("Invalid pane credentials");
	unlinkSync(credentialPath);
	const terminal = new ProcessTerminal();
	const ui = new TuiAltScreen(terminal, true);
	const socket = connect({ host: "127.0.0.1", port: credentials.port });
	socket.setNoDelay(true);
	let lines: string[] = [];
	let columns = 0;
	let rows = 0;
	let authenticated = false;
	const closed = Promise.withResolvers<void>();
	const component = {
		focused: true,
		render(width: number) {
			const nextColumns = Math.max(1, Math.min(width, 1000));
			const nextRows = Math.max(1, Math.min(terminal.rows, 500));
			if (authenticated && (columns !== nextColumns || rows !== nextRows)) {
				columns = nextColumns;
				rows = nextRows;
				sendPacket(socket, { type: "resize", columns, rows });
			}
			return lines;
		},
		handleInput(data: string) {
			if (authenticated) sendPacket(socket, { type: "input", data });
		},
		invalidate() {},
	};
	const stop = () => {
		socket.destroy();
		closed.resolve();
	};
	const onSignal = () => stop();
	socket.setTimeout(15000, () => socket.destroy(new Error("Pane owner did not send an initial frame")));
	socket.once("connect", () => {
		columns = Math.max(1, Math.min(terminal.columns, 1000));
		rows = Math.max(1, Math.min(terminal.rows, 500));
		sendPacket(socket, { type: "hello", proof: localProof(credentials.token, "pane-client"), columns, rows });
	});
	socket.once("error", (error) => closed.reject(error));
	socket.once("close", () => closed.resolve());
	receivePackets(socket, (packet) => {
		// Trust boundary: accept only bounded display frames from the authenticated owner socket.
		if (!outputValidator.Check(packet)) return socket.destroy(new Error("Invalid pane display frame"));
		if (packet.type === "ready") {
			if (authenticated || !verifyLocalProof(credentials.token, "pane-server", packet.proof)) {
				return socket.destroy(new Error("Pane owner could not be authenticated"));
			}
			authenticated = true;
			return;
		}
		if (!authenticated) return socket.destroy(new Error("Pane owner has not authenticated"));
		if (packet.type === "close") return stop();
		socket.setTimeout(0);
		lines = packet.lines;
		ui.requestRender();
	});
	process.once("SIGTERM", onSignal);
	process.once("SIGHUP", onSignal);
	process.once("SIGINT", onSignal);
	ui.addChild(component);
	ui.setFocus(component);
	try {
		ui.start();
		await closed.promise;
	} finally {
		process.removeListener("SIGTERM", onSignal);
		process.removeListener("SIGHUP", onSignal);
		process.removeListener("SIGINT", onSignal);
		socket.destroy();
		ui.stop();
	}
}
