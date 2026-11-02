// Fixture child process (slice 10): writes to stdout and stderr, spawns a grandchild, sends a link frame and a control
// message at once, then lives until killed.

import { spawn } from "node:child_process";
import { envelope } from "../../../../src/next-node/workers/control.ts";

const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
process.stdout.write(`grandchild ${grandchild.pid}\n`);
process.stderr.write("an error line\n");
process.send?.(new Uint8Array([1, 2, 3]));
process.send?.(envelope({ kind: "started" }));
setInterval(() => {}, 1000);
