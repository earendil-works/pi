import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { getSocketPath } from "./config.ts";
import { handleIpcRequest, openRpcStream } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";
import { getRadiusOrchestratorBaseUrl, isRadiusEnabled, radiusPresence } from "./radius.ts";
import { supervisor } from "./supervisor.ts";

export async function serve(): Promise<void> {
	const socketPath = getSocketPath();
	mkdirSync(dirname(socketPath), { recursive: true });
	const server = await startIpcServer(
		Object.assign(handleIpcRequest, {
			openRpcStream,
		}),
	);

	try {
		await supervisor.recoverAfterRestart();
		if (isRadiusEnabled()) {
			const machine = await radiusPresence.start();
			console.log(`radius integration enabled: ${socketPath} -> ${getRadiusOrchestratorBaseUrl()}`);
			if (machine) {
				console.log(`radius machine id: ${machine.id}`);
			}
		} else {
			console.log("radius integration disabled: login radius in ~/.pi/agent/auth.json or set RADIUS_API_KEY");
		}
	} catch (error) {
		server.close();
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
		throw error;
	}

	console.log(`orchestrator listening on ${socketPath}`);

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = async (exitCode: number) => {
		if (shutdownPromise) {
			await shutdownPromise;
			process.exit(exitCode);
		}

		shutdownPromise = (async () => {
			server.close();
			await supervisor.shutdown();
			await radiusPresence.stop();
			if (existsSync(socketPath)) {
				unlinkSync(socketPath);
			}
		})();

		await shutdownPromise;
		process.exit(exitCode);
	};

	process.on("SIGINT", () => {
		void shutdown(0);
	});
	process.on("SIGTERM", () => {
		void shutdown(0);
	});
	process.on("uncaughtException", (error) => {
		console.error(error);
		void shutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(reason);
		void shutdown(1);
	});

	await new Promise<void>(() => {
		// Keep the process alive until a signal or fatal error triggers shutdown.
	});
}
