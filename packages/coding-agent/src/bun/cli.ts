#!/usr/bin/env node
process.title = "pi";

await import("./register-bedrock.js");
await import("../cli.js");
