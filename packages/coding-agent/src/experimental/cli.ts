#!/usr/bin/env node
import { setupCli } from "../cli/setup.ts";
import { main } from "../main.ts";
import { runExperimentalCommand } from "./commands.ts";

setupCli();
const args = process.argv.slice(2);
if (await runExperimentalCommand(args)) {
	if (args[0] === "client") process.exit(process.exitCode ?? 0);
} else {
	await main(args);
}
