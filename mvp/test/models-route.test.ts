import { describe, expect, it, vi } from "vitest";
import { handleModelsRequest, type ModelsRouteDeps } from "../src/agent/models-route.ts";
import type { AgentResponse } from "../src/agent/route.ts";
import type { GatewayCatalogModel } from "../src/gateway/free-models.ts";

function makeResponse() {
  const out = { status: 0, json: undefined as unknown, headers: {} as Record<string, string> };
  const response: AgentResponse = {
    setHeader(name, value) {
      out.headers[name] = value;
    },
    status(code) {
      out.status = code;
      return {
        json(body) {
          out.json = body;
        },
      };
    },
    write() {},
    end() {},
  };
  return { out, response };
}

// Synthetic ids on purpose: tests must not depend on any real model name.
const free = (id: string, extra: Partial<GatewayCatalogModel> = {}): GatewayCatalogModel => ({
  id,
  type: "language",
  tags: ["tool-use"],
  context_window: 50_000,
  pricing: { input: "0", output: "0" },
  ...extra,
});
const priced = free("synthetic/priced", { pricing: { input: "0.01", output: "0" } });
const noTools = free("synthetic/no-tools", { tags: [] });

function makeDeps(overrides: Partial<ModelsRouteDeps> = {}) {
  const fetchCatalog = vi.fn(async (): Promise<readonly GatewayCatalogModel[]> => [free("synthetic/a", { name: "Model A" }), priced, noTools, free("synthetic/b", { context_window: 90_000 })]);
  const deps: ModelsRouteDeps = { env: { NLT_AGENT_ENABLED: "1" }, authorize: () => true, fetchCatalog, ...overrides };
  return { deps, fetchCatalog };
}

describe("handleModelsRequest", () => {
  it("answers 404 and reads nothing when the agent is off", async () => {
    const { deps, fetchCatalog } = makeDeps({ env: {} });
    const r = makeResponse();
    await handleModelsRequest({ method: "GET" }, r.response, deps);
    expect(r.out.status).toBe(404);
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it("answers 405 for non-GET and 401 without an owner session, reading nothing", async () => {
    const { deps, fetchCatalog } = makeDeps();
    const post = makeResponse();
    await handleModelsRequest({ method: "POST" }, post.response, deps);
    expect(post.out.status).toBe(405);
    expect(post.out.headers.Allow).toBe("GET");

    const denied = makeResponse();
    await handleModelsRequest({ method: "GET" }, denied.response, { ...deps, authorize: () => false });
    expect(denied.out.status).toBe(401);
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it("lists only free tool-capable models, best first, and never a priced one", async () => {
    const { deps } = makeDeps();
    const r = makeResponse();
    await handleModelsRequest({ method: "GET" }, r.response, deps);
    expect(r.out.status).toBe(200);
    expect(r.out.headers["Cache-Control"]).toBe("no-store");
    expect(r.out.json).toEqual({
      models: [
        { id: "synthetic/b", name: "synthetic/b", contextWindow: 90_000 },
        { id: "synthetic/a", name: "Model A", contextWindow: 50_000 },
      ],
    });
  });

  it("answers 503 with an empty list when the catalog cannot be read", async () => {
    const { deps } = makeDeps({
      fetchCatalog: async () => {
        throw new Error("down");
      },
    });
    const r = makeResponse();
    await handleModelsRequest({ method: "GET" }, r.response, deps);
    expect(r.out.status).toBe(503);
    expect(r.out.json).toEqual({ error: "Model list unavailable", models: [] });
  });

  it("answers an empty list, not an error, when nothing is free", async () => {
    const { deps } = makeDeps({ fetchCatalog: async () => [priced] });
    const r = makeResponse();
    await handleModelsRequest({ method: "GET" }, r.response, deps);
    expect(r.out.status).toBe(200);
    expect(r.out.json).toEqual({ models: [] });
  });
});
