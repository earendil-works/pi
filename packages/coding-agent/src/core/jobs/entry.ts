// Lightweight process entry: do not load the model/session/UI runtime for a job supervisor.
import { runJobWorker } from "./worker.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Missing job directory");
runJobWorker(directory).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
