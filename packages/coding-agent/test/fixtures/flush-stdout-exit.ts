// Writes output, flushes stdout and exits, like pi after stopping a TUI. Used by flush-stdout.test.ts.
import { flushStdout } from "../../src/utils/flush-stdout.ts";

process.stdout.write(`${"x".repeat(Number(process.argv[2]))}END`);
await flushStdout();
process.exit(0);
