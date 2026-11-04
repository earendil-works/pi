// Runs before main.ts is parsed, so terminal-host startup failures also reach the bounded redacted log snapshot.
import { capturePublishedLogs } from "../../src/runtime/logs.ts";

const directory = process.argv[2];
if (directory) capturePublishedLogs("terminals", directory);
