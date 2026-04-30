#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { APP_NAME } from "./config.js";
import { main } from "./main.js";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// bodyTimeout/headersTimeout default to 300s in undici; long local-LLM stalls
// (e.g. vLLM buffering a large tool call) exceed that and abort the SSE stream
// with UND_ERR_BODY_TIMEOUT. Disable both — provider SDKs enforce their own
// AbortController-based deadlines via retry.provider.timeoutMs.
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

main(process.argv.slice(2));
