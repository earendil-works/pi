/**
 * Lists the free, tool-capable gateway models for the chat page's model selector.
 * Same off-by-default flag and owner sign-in as /api/agent. See src/agent/models-route.ts for the contract.
 */
import type { AgentRequest, AgentResponse } from "../src/agent/route.ts";
import { handleModelsRequest } from "../src/agent/models-route.ts";
import { fetchGatewayCatalog } from "../src/gateway/free-models.ts";
import { sessionFromCookie } from "../src/auth/owner.ts";

export default async function handler(request: AgentRequest, response: AgentResponse) {
  await handleModelsRequest(request, response, {
    env: process.env,
    authorize: (req) => sessionFromCookie(process.env, req.headers?.cookie) !== undefined,
    fetchCatalog: () => fetchGatewayCatalog(),
  });
}
