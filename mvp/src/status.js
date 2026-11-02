/**
 * Reports application integration state without granting execution authority.
 *
 * This is an observability contract only. It is not an ASFDK decision and must
 * never be used as a substitute for the harness or execution-boundary checks.
 */
export function createStatusPayload({
  runtimeIntegrated = false,
  governanceVerified = false,
} = {}) {
  return {
    service: "nlt-pi-mvp",
    status: "ok",
    runtime: runtimeIntegrated ? "integrated" : "not-integrated",
    governance: governanceVerified ? "verified" : "not-verified",
    execution: "disabled",
    executionEnabled: false,
  };
}
