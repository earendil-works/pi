// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import djsWasmPath from "@earendil-works/djs/wasm/djs.wasm";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
import { APP_NAME, setEmbeddedDjsWasmPath } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
setEmbeddedDjsWasmPath(djsWasmPath);
