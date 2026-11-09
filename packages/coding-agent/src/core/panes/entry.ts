// Lightweight terminal viewer entry: conversation state remains in the owning pi process.
import { runPaneClient } from "./client.ts";

const credentials = process.argv[2];
if (!credentials) throw new Error("Missing pane credentials path");
runPaneClient(credentials).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
