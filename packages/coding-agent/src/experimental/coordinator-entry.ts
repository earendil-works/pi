#!/usr/bin/env node
import { runCoordinatorProcess } from "./coordinator.ts";
import { consumeInternalProcessRole } from "./process.ts";

const role = consumeInternalProcessRole();
if (role !== "coordinator") throw new Error("Coordinator entrypoint requires an internal coordinator invocation");
void runCoordinatorProcess(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
