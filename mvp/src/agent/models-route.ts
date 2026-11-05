/**
 * The model-list route, as a testable function. `api/models.ts` wires it to the live gateway catalog.
 *
 * Same access rules as the agent route: 404 unless the owner set `NLT_AGENT_ENABLED=1`, 401 without a signed-in
 * owner. It lists only models that are free right now and support tools (`selectFreeModels`), read from the
 * public catalog at request time, narrowed to the owner's `NLT_AGENT_MODELS` allow-list when it is set. If the catalog cannot be read the answer is 503 with an empty list; a priced
 * model is never listed. The list is informational: `/api/agent` re-checks a chosen model inside the turn.
 */
import { type GatewayCatalogModel, parseAllowedModels, parseDefaultModel, selectFreeModels } from "../gateway/free-models.ts";
import { type AgentRequest, type AgentResponse, agentEnabled } from "./route.ts";

export interface ListedModel {
  id: string;
  name: string;
  contextWindow: number | null;
}

export interface ModelsRouteDeps {
  env: { NLT_AGENT_ENABLED?: string | undefined; NLT_AGENT_MODELS?: string | undefined; NLT_AGENT_DEFAULT_MODEL?: string | undefined };
  /** True only for a signed-in owner. */
  authorize: (request: AgentRequest) => boolean;
  /** Reads the live gateway catalog. Throws when it cannot be read. */
  fetchCatalog: () => Promise<readonly GatewayCatalogModel[]>;
}

export function toListedModel(model: GatewayCatalogModel): ListedModel {
  return {
    id: model.id,
    name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
    contextWindow: typeof model.context_window === "number" && Number.isFinite(model.context_window) ? model.context_window : null,
  };
}

export async function handleModelsRequest(request: AgentRequest, response: AgentResponse, deps: ModelsRouteDeps): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  if (!agentEnabled(deps.env)) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!deps.authorize(request)) {
    response.status(401).json({ error: "Sign in required" });
    return;
  }
  try {
    const catalog = await deps.fetchCatalog();
    const allowed = parseAllowedModels(deps.env.NLT_AGENT_MODELS);
    // The owner's default comes first, so the list matches what "Auto" picks.
    const preferred = parseDefaultModel(deps.env.NLT_AGENT_DEFAULT_MODEL);
    const models = selectFreeModels(catalog, { requireToolUse: true, allowed, preferred }).map(toListedModel);
    response.status(200).json({ models });
  } catch {
    response.status(503).json({ error: "Model list unavailable", models: [] });
  }
}
