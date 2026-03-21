import { createRequire } from "node:module";
import * as _bundledPiAgentCore from "@mariozechner/pi-agent-core";
import * as _bundledPiAi from "@mariozechner/pi-ai";
import * as _bundledPiAiOauth from "@mariozechner/pi-ai/oauth";
import * as _bundledPiTui from "@mariozechner/pi-tui";
import * as _bundledTypebox from "@sinclair/typebox";
import { setExtensionVirtualModules } from "../core/extensions/virtual-modules-registry.js";
import type * as PiCodingAgent from "../index.js";

const require = createRequire(import.meta.url);
const _bundledPiCodingAgent = require("../extension-api.cjs") as typeof PiCodingAgent;

setExtensionVirtualModules({
	"@sinclair/typebox": _bundledTypebox,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAi,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
});
