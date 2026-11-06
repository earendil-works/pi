export function accessRequestsEnabled(env: { NLT_ACCESS_REQUESTS?: string | undefined }): boolean {
  return env.NLT_ACCESS_REQUESTS === "1";
}
