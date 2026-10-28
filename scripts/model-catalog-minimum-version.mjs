// The oldest pi version that receives model catalogs published from this checkout.
// pi.dev keeps one catalog per minimum version; clients older than this keep the
// last catalog published under the previous minimum and stop receiving updates.
//
// Bump this only when generated model metadata requires behavior unavailable in
// older pi clients, in the same commit as the change that requires it.
// 1.2.1: kimi-coding models use openai-completions at /coding/v1; older clients only
// implement anthropic-messages for kimi-coding and ignore a model's api.
export const MINIMUM_PI_VERSION = "1.2.1";
