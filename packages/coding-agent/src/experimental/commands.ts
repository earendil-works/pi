import chalk from "chalk";
import { cli } from "../cli/experimental/cli.ts";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import type { ServerCommand } from "../cli/experimental/commands/server.ts";
import { areExperimentalFeaturesEnabled } from "../core/experimental.ts";
import { runClient } from "./client.ts";
import { runClientTui } from "./client-tui.ts";
import type { RadiusRelayHostStatus } from "./radius-relay.ts";
import { startForegroundServer } from "./server.ts";

async function runServerCommand(command: ServerCommand): Promise<void> {
	let previousRelayStatus = "";
	let relayOutputReady = false;
	let pendingRelayStatus: RadiusRelayHostStatus | undefined;
	const reportRelayStatus = (status: RadiusRelayHostStatus): void => {
		const description =
			status.status === "connected"
				? "connected"
				: status.status === "not_authenticated"
					? "not connected; local only"
					: status.status === "retrying"
						? `reconnecting: ${status.error}`
						: "connecting";
		if (description === previousRelayStatus || status.status === "connecting") return;
		previousRelayStatus = description;
		console.log(`Radius: ${description}`);
	};
	const runtime = await startForegroundServer({
		serverId: command.serverId,
		sessionDir: command.sessionDir,
		provider: command.provider,
		model: command.model,
		pluginPackages: command.pluginPackages ?? [],
		relayAuth: command.auth,
		onRelayStatus(status) {
			if (relayOutputReady) reportRelayStatus(status);
			else pendingRelayStatus = status;
		},
	});
	console.log(`Server: ${runtime.serverId}`);
	console.log(`Socket: ${runtime.socketPath}`);
	relayOutputReady = true;
	if (pendingRelayStatus !== undefined) reportRelayStatus(pendingRelayStatus);
	try {
		await new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				process.off("SIGINT", finish);
				process.off("SIGTERM", finish);
			};
			const finish = (): void => {
				cleanup();
				resolve();
			};
			const fail = (error: unknown): void => {
				cleanup();
				reject(error);
			};
			process.once("SIGINT", finish);
			process.once("SIGTERM", finish);
			void runtime.closed.then(finish, fail);
		});
	} finally {
		await runtime.close();
	}
}

async function runClientCommand(command: ClientCommand): Promise<void> {
	if (command.prompt === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true) {
		await runClientTui(command);
		return;
	}
	let streamedText = false;
	const result = await runClient(command, {
		onEvent(event) {
			if (event.type !== "message_update" || event.frame?.type !== "text_delta") return;
			streamedText = true;
			process.stdout.write(event.frame.delta);
		},
	});
	if (result.kind === "attached") {
		console.log(`${result.serverId}\t${result.sessionId}\tattached`);
		return;
	}
	if (result.kind === "prompted") {
		if (streamedText) process.stdout.write("\n");
		else console.log(result.text);
		return;
	}
	for (const session of result.sessions) console.log(`${session.serverId}\t${session.sessionId}`);
}

/** Development-only command dispatch. Published entrypoints must not import this module. */
export async function runExperimentalCommand(args: string[]): Promise<boolean> {
	if (!areExperimentalFeaturesEnabled() || (args[0] !== "server" && args[0] !== "client")) return false;
	try {
		const result = await cli.execute(args, { runServer: runServerCommand, runClient: runClientCommand });
		if (!result.ok) {
			for (const error of result.errors) console.error(chalk.red(`Error: ${error}`));
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
	return true;
}
