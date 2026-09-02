#!/usr/bin/env node
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

registerBunOAuthFlows();

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

// Literal imports keep both Node-only SDK trees discoverable to Bun while
// deferring their evaluation until the original process environment is restored.
await import("./register-bedrock.ts");
await import("./register-anthropic-vertex.ts");
await import("../cli.ts");
