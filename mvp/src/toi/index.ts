/**
 * TOI / OTOI standing-terms module, server side only.
 *
 * Re-exports the loader, verifier, honorer, and retention modules so consumers
 * import from one place. No part of this module is passed to the model or the
 * sandbox; it is used by the agent route and the runner before each turn.
 */

export { loadToi, loadOtoI, resolveToiPath, resolveOtoIPath } from "./loader.ts";
export { verifyToiDocument, verifyOtoICharter, type ToiVerifyResult, type OtoIVerifyResult } from "./verifier.ts";
export { honorAndPropagate, type HonorResult, AGENT_ID } from "./honorer.ts";
export { memoryAllowedByRetention, ALLOWED_RETENTION } from "./retention.ts";