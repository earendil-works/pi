// @vitest-evals/harness-pi-ai 0.15.0 imports completeSimple from the legacy
// @mariozechner/pi-ai entry point. Remove this shim when the harness supports
// the current @earendil-works/pi-ai API.
export * from "@earendil-works/pi-ai";
export { completeSimple } from "@earendil-works/pi-ai/compat";
