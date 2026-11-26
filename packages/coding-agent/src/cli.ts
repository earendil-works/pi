#!/usr/bin/env node
// First: --agent-dir must be set before any module that reads the agent dir loads.
import "./cli/agent-dir-setup.ts";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();
main(process.argv.slice(2));
