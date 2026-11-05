import { describe, expect, it } from "vitest";
import {
  GATEWAY_MODELS_URL,
  NoFreeModelError,
  fetchGatewayCatalog,
  isFreeLanguageModel,
  parseAllowedModels,
  parseDefaultModel,
  pickFreeModel,
  selectFreeModels,
  type GatewayCatalogModel,
} from "../src/gateway/free-models.ts";

// Synthetic ids on purpose: source and tests must not depend on any real model name.
const model = (overrides: Partial<GatewayCatalogModel> & { id: string }): GatewayCatalogModel => ({
  type: "language",
  tags: ["tool-use"],
  context_window: 100_000,
  pricing: { input: "0", output: "0" },
  ...overrides,
});

const response = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
  (async () => ({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body })) as unknown as typeof fetch;

describe("isFreeLanguageModel", () => {
  it("accepts zero input and output prices, as strings or numbers", () => {
    expect(isFreeLanguageModel(model({ id: "a" }))).toBe(true);
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: 0, output: 0 } }))).toBe(true);
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: "0.0", output: "0e0" } }))).toBe(true);
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: "0", output: "0", input_cache_read: "0" } }))).toBe(true);
  });

  it("rejects any non-zero price, however small", () => {
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: "0.000001", output: "0" } }))).toBe(false);
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: "0", output: "0.0000001" } }))).toBe(false);
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: "0", output: "0", input_cache_write: "0.1" } }))).toBe(false);
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: -0.0, output: 1e-12 } }))).toBe(false);
  });

  it("treats unknown, missing or malformed pricing as not free", () => {
    for (const pricing of [undefined, null, {}, { input: "0" }, { output: "0" }, { input: "", output: "" }, { input: null, output: null }, { input: "free", output: "free" }, { input: "NaN", output: "0" }]) {
      expect(isFreeLanguageModel(model({ id: "a", pricing: pricing as never }))).toBe(false);
    }
  });

  it("rejects prices that only round to zero, and pricing with inherited fields", () => {
    for (const input of ["1e-400", "1e-324", "0x0", "0b0", "1E-999", "+1e-400"]) {
      expect(isFreeLanguageModel(model({ id: "a", pricing: { input, output: "0" } }))).toBe(false);
    }
    const inherited = Object.create({ input: "1", output: "1" });
    expect(isFreeLanguageModel(model({ id: "a", pricing: inherited }))).toBe(false);
    const hidden = Object.create({ input_cache_write: "9" });
    hidden.input = "0";
    hidden.output = "0";
    expect(isFreeLanguageModel(model({ id: "a", pricing: hidden }))).toBe(false);
    const bare = Object.assign(Object.create(null), { input: "0", output: "0" });
    expect(isFreeLanguageModel(model({ id: "a", pricing: bare }))).toBe(true);
  });

  it("rejects a price that varies by provider", () => {
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: "0", output: "0", varies_by_provider: true } }))).toBe(false);
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: "0", output: "0", varies_by_provider: false } }))).toBe(true);
    expect(isFreeLanguageModel(model({ id: "a", pricing: { input: "0", output: "0", varies_by_provider: "yes" } }))).toBe(false);
  });

  it("rejects tiered, regional, per-request or otherwise unrecognised price fields", () => {
    for (const extra of [{ input_tiers: [] }, { output_tiers: [{ cost: "0" }] }, { regional: { eu: { input: "0" } } }, { web_search: "0" }, { image: "0" }, { something_new: "0" }]) {
      expect(isFreeLanguageModel(model({ id: "a", pricing: { input: "0", output: "0", ...extra } }))).toBe(false);
    }
  });

  it("rejects non-language models and entries without an id", () => {
    expect(isFreeLanguageModel(model({ id: "a", type: "image" }))).toBe(false);
    expect(isFreeLanguageModel(model({ id: "a", type: undefined }))).toBe(false);
    expect(isFreeLanguageModel(model({ id: "" }))).toBe(false);
    expect(isFreeLanguageModel({} as GatewayCatalogModel)).toBe(false);
    expect(isFreeLanguageModel(null as never)).toBe(false);
  });
});

describe("selectFreeModels", () => {
  const catalog = [
    model({ id: "priced", pricing: { input: "0.000002", output: "0.000012" } }),
    model({ id: "free-small", context_window: 8000 }),
    model({ id: "free-big", context_window: 1_000_000 }),
    model({ id: "free-no-tools", tags: ["reasoning"], context_window: 2_000_000 }),
    model({ id: "free-varies", pricing: { input: "0", output: "0", varies_by_provider: true } }),
    model({ id: "free-image", type: "image" }),
  ];

  it("keeps only free language models with tool support, largest context first", () => {
    expect(selectFreeModels(catalog).map((m) => m.id)).toEqual(["free-big", "free-small"]);
  });

  it("can allow models without tool support when asked", () => {
    expect(selectFreeModels(catalog, { requireToolUse: false }).map((m) => m.id)).toEqual(["free-no-tools", "free-big", "free-small"]);
  });

  it("puts preferred ids first, but never lets a preference make a priced model eligible", () => {
    expect(selectFreeModels(catalog, { preferred: ["free-small"] }).map((m) => m.id)).toEqual(["free-small", "free-big"]);
    expect(selectFreeModels(catalog, { preferred: ["priced", "free-varies"] }).map((m) => m.id)).toEqual(["free-big", "free-small"]);
  });

  it("breaks ties by id so the choice is stable", () => {
    const ties = [model({ id: "b" }), model({ id: "a" }), model({ id: "c" })];
    expect(selectFreeModels(ties).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores malformed tags and context windows instead of throwing or misordering", () => {
    const messy = [
      model({ id: "bad-tags", tags: 42 as never }),
      model({ id: "obj-tags", tags: {} as never }),
      model({ id: "nan-ctx", context_window: "big" as never }),
      model({ id: "ok", context_window: 10 }),
    ];
    expect(selectFreeModels(messy).map((m) => m.id)).toEqual(["ok", "nan-ctx"]);
  });

  it("returns an empty list for an empty catalog", () => {
    expect(selectFreeModels([])).toEqual([]);
  });
});

describe("owner default model", () => {
  const catalog = [
    model({ id: "priced", pricing: { input: "0.000002", output: "0.000012" } }),
    model({ id: "free-small", context_window: 8000 }),
    model({ id: "free-big", context_window: 1_000_000 }),
  ];

  it("parses one trimmed id, and blank as no default", () => {
    expect(parseDefaultModel("  free-small ")).toEqual(["free-small"]);
    for (const value of [undefined, "", "   "]) expect(parseDefaultModel(value)).toEqual([]);
  });

  it("is picked when none is requested, but never makes a priced or disallowed model eligible", async () => {
    expect((await pickFreeModel({ fetchImpl: response({ data: catalog }), preferred: ["free-small"] })).id).toBe("free-small");
    expect((await pickFreeModel({ fetchImpl: response({ data: catalog }), preferred: ["priced"] })).id).toBe("free-big");
    expect((await pickFreeModel({ fetchImpl: response({ data: catalog }), preferred: ["free-small"], allowed: ["free-big"] })).id).toBe("free-big");
  });

  it("does not override an explicit request", async () => {
    expect((await pickFreeModel({ fetchImpl: response({ data: catalog }), preferred: ["free-small"], requested: "free-big" })).id).toBe("free-big");
  });
});

describe("owner model allow-list", () => {
  const catalog = [
    model({ id: "priced", pricing: { input: "0.000002", output: "0.000012" } }),
    model({ id: "free-small", context_window: 8000 }),
    model({ id: "free-big", context_window: 1_000_000 }),
    model({ id: "free-no-tools", tags: ["reasoning"] }),
  ];

  it("keeps only allowed free models, and never lets the list add a priced or tool-less one", () => {
    expect(selectFreeModels(catalog, { allowed: ["free-small"] }).map((m) => m.id)).toEqual(["free-small"]);
    expect(selectFreeModels(catalog, { allowed: ["priced", "free-no-tools", "free-small"] }).map((m) => m.id)).toEqual(["free-small"]);
    expect(selectFreeModels(catalog, { allowed: ["not-in-catalog"] })).toEqual([]);
  });

  it("is no restriction when empty or unset", () => {
    expect(selectFreeModels(catalog, { allowed: [] }).map((m) => m.id)).toEqual(["free-big", "free-small"]);
    expect(selectFreeModels(catalog, { allowed: undefined }).map((m) => m.id)).toEqual(["free-big", "free-small"]);
  });

  it("parses a comma-separated value and treats blank as unset", () => {
    expect(parseAllowedModels(" a/one , b/two,,  ")).toEqual(["a/one", "b/two"]);
    for (const value of [undefined, "", " ", " , ,"]) expect(parseAllowedModels(value)).toBeUndefined();
  });

  it("picks only from the allow-list, refuses a request outside it, and says why when nothing is left", async () => {
    expect((await pickFreeModel({ fetchImpl: response({ data: catalog }), allowed: ["free-small"] })).id).toBe("free-small");
    await expect(pickFreeModel({ fetchImpl: response({ data: catalog }), allowed: ["free-small"], requested: "free-big" })).rejects.toThrow(
      /not in the owner's allowed models \(NLT_AGENT_MODELS\): free-big/,
    );
    // A priced request is reported as not free, whether or not an allow-list is set.
    await expect(pickFreeModel({ fetchImpl: response({ data: catalog }), allowed: ["free-small"], requested: "priced" })).rejects.toThrow(
      /not a free model right now: priced/,
    );
    await expect(pickFreeModel({ fetchImpl: response({ data: catalog }), allowed: ["priced"] })).rejects.toThrow(/NLT_AGENT_MODELS/);
  });
});

describe("fetchGatewayCatalog", () => {
  it("reads the model list from the public catalog URL", async () => {
    let requested: unknown;
    const fetchImpl = (async (url: unknown) => {
      requested = url;
      return { ok: true, status: 200, json: async () => ({ object: "list", data: [model({ id: "a" })] }) };
    }) as unknown as typeof fetch;
    const result = await fetchGatewayCatalog({ fetchImpl });
    expect(requested).toBe(GATEWAY_MODELS_URL);
    expect(result.map((m) => m.id)).toEqual(["a"]);
  });

  it("fails with NoFreeModelError on a bad status, a bad body, or a network error", async () => {
    await expect(fetchGatewayCatalog({ fetchImpl: response({}, { ok: false, status: 503 }) })).rejects.toBeInstanceOf(NoFreeModelError);
    await expect(fetchGatewayCatalog({ fetchImpl: response({ data: "nope" }) })).rejects.toBeInstanceOf(NoFreeModelError);
    await expect(fetchGatewayCatalog({ fetchImpl: response(null) })).rejects.toBeInstanceOf(NoFreeModelError);
    const broken = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(fetchGatewayCatalog({ fetchImpl: broken })).rejects.toBeInstanceOf(NoFreeModelError);
  });

  it("times out instead of waiting forever", async () => {
    const hanging = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(fetchGatewayCatalog({ fetchImpl: hanging, timeoutMs: 20 })).rejects.toBeInstanceOf(NoFreeModelError);
  });

  it("drops entries that are not objects", async () => {
    const result = await fetchGatewayCatalog({ fetchImpl: response({ data: [model({ id: "a" }), null, 7, "x"] }) });
    expect(result.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("pickFreeModel", () => {
  const catalog = {
    data: [
      model({ id: "priced", pricing: { input: "0.1", output: "0.1" } }),
      model({ id: "free-a", context_window: 1000 }),
      model({ id: "free-b", context_window: 5000 }),
    ],
  };

  it("picks the best free model", async () => {
    expect((await pickFreeModel({ fetchImpl: response(catalog) })).id).toBe("free-b");
  });

  it("uses a requested model only if it is free right now, and never substitutes another", async () => {
    expect((await pickFreeModel({ fetchImpl: response(catalog), requested: "free-a" })).id).toBe("free-a");
    await expect(pickFreeModel({ fetchImpl: response(catalog), requested: "priced" })).rejects.toBeInstanceOf(NoFreeModelError);
    await expect(pickFreeModel({ fetchImpl: response(catalog), requested: "not-listed" })).rejects.toBeInstanceOf(NoFreeModelError);
  });

  it("fails closed when there is no free model, or the catalog cannot be read", async () => {
    const onlyPriced = { data: [model({ id: "priced", pricing: { input: "1", output: "1" } })] };
    await expect(pickFreeModel({ fetchImpl: response(onlyPriced) })).rejects.toBeInstanceOf(NoFreeModelError);
    await expect(pickFreeModel({ fetchImpl: response({ data: [] }) })).rejects.toBeInstanceOf(NoFreeModelError);
    await expect(pickFreeModel({ fetchImpl: response({}, { ok: false, status: 500 }) })).rejects.toBeInstanceOf(NoFreeModelError);
  });
});
