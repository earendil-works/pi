/**
 * Reports live application state without granting execution authority.
 *
 * This is an observability contract only. It is not an ASFDK decision and must
 * never be used as a substitute for the harness or execution-boundary checks.
 * Every value is read from the server's own environment flags with the same
 * strict `=== "1"` rule the routes use (anything else is off); nothing here is
 * taken from request input, and nothing here switches a capability on.
 */
const flagOn = (value) => value === "1";

export function createStatusPayload({ env = {}, governanceVerified = false, now = () => new Date() } = {}) {
  const agentOn = flagOn(env.NLT_AGENT_ENABLED);
  return {
    service: "nlt-pi-mvp",
    status: "ok",
    runtime: agentOn ? "enabled" : "disabled",
    governance: governanceVerified ? "verified" : "not-verified",
    execution: agentOn ? "enabled" : "disabled",
    executionEnabled: agentOn,
    egress: agentOn ? (flagOn(env.NLT_AGENT_EGRESS_ALL) ? "allow-all" : "allowlist") : "none",
    history: flagOn(env.NLT_HISTORY_ENABLED) ? "enabled" : "disabled",
    checkedAt: now().toISOString(),
  };
}
