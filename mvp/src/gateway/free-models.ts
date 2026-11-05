/**
 * Free-model selection for the Vercel AI Gateway.
 *
 * Owner decision (2026-11-04): only free models are allowed through the gateway. "Free" is decided from
 * the gateway's public model catalog at the time of use, not from a hand-kept list, and no model
 * identifiers are written into source. If the catalog cannot be read, or no listed model is free, or a
 * requested model is not free right now, the answer is an error. Unknown is never treated as free.
 *
 * This module only reads the public, unauthenticated catalog. It does not call a model, hold credentials,
 * or run anything, and nothing in the application calls it yet.
 */

export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

export interface GatewayCatalogModel {
  id: string;
  name?: string;
  type?: string;
  context_window?: number;
  max_tokens?: number;
  tags?: string[];
  pricing?: Record<string, unknown>;
}

/** Thrown when no allowed (free) model can be chosen. The caller must not fall back to a priced model. */
export class NoFreeModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoFreeModelError";
  }
}

/** Pricing fields a free model may carry, each of which must be exactly zero when present. */
const PRICE_FIELDS = new Set(["input", "output", "input_cache_read", "input_cache_write"]);

function isZeroPrice(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value === 0;
  if (typeof value === "string") {
    const text = value.trim();
    // Plain decimal notation only. Number() would round "1e-400" down to 0, so check the digits instead.
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return false;
    return !/[1-9]/.test(text.split(/e/i)[0] ?? "");
  }
  return false;
}

/**
 * True only for a language model whose input and output prices are listed and exactly zero, with every
 * other price field also zero, and whose price is not flagged as varying by provider. Anything unusual
 * (missing pricing, tiered or regional pricing, unknown price fields, a provider-dependent price) is not free.
 */
export function isFreeLanguageModel(model: GatewayCatalogModel): boolean {
  if (typeof model?.id !== "string" || model.id.length === 0) return false;
  if (model.type !== "language") return false;
  const pricing = model.pricing;
  if (pricing === null || typeof pricing !== "object") return false;
  // Inherited properties would pass the presence checks below without being checked as prices.
  const prototype = Object.getPrototypeOf(pricing);
  if (prototype !== Object.prototype && prototype !== null) return false;

  // A price that depends on the serving provider is not guaranteed to be zero.
  if (pricing.varies_by_provider === true) return false;

  if (!("input" in pricing) || !("output" in pricing)) return false;
  for (const [key, value] of Object.entries(pricing)) {
    if (key === "varies_by_provider") {
      if (value !== false && value !== undefined && value !== null) return false;
      continue;
    }
    if (!PRICE_FIELDS.has(key)) return false;
    if (!isZeroPrice(value)) return false;
  }
  return true;
}

export interface SelectOptions {
  /** Require the "tool-use" capability tag. A coding agent needs it. Default true. */
  requireToolUse?: boolean;
  /** Model ids to prefer, in order, if they are free at this moment. */
  preferred?: readonly string[];
  /**
   * Owner-set allow-list (`NLT_AGENT_MODELS`). When given and non-empty, only free models with one of these ids are
   * kept. It narrows the free list and never adds to it, so a listed model that is priced is still excluded. Used
   * because the catalog does not say which free models a plan can call (the free tier is refused some of them).
   */
  allowed?: readonly string[];
}

const contextWindowOf = (model: GatewayCatalogModel): number =>
  typeof model.context_window === "number" && Number.isFinite(model.context_window) ? model.context_window : 0;

/** Free language models from a catalog, best first: preferred ids, then larger context, then id order. */
export function selectFreeModels(
  catalog: readonly GatewayCatalogModel[],
  options: SelectOptions = {},
): GatewayCatalogModel[] {
  const requireToolUse = options.requireToolUse ?? true;
  const preferred = options.preferred ?? [];
  const allowed = options.allowed && options.allowed.length > 0 ? new Set(options.allowed) : undefined;
  const free = catalog.filter(
    (model) =>
      isFreeLanguageModel(model) &&
      (!requireToolUse || (Array.isArray(model.tags) && model.tags.includes("tool-use"))) &&
      (allowed === undefined || allowed.has(model.id)),
  );
  const rank = (model: GatewayCatalogModel): number => {
    const index = preferred.indexOf(model.id);
    return index === -1 ? preferred.length : index;
  };
  return free.slice().sort((a, b) => {
    const byPreference = rank(a) - rank(b);
    if (byPreference !== 0) return byPreference;
    const byContext = contextWindowOf(b) - contextWindowOf(a);
    if (byContext !== 0) return byContext;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Reads the owner's model allow-list from a comma-separated value (`NLT_AGENT_MODELS`). Blank entries are dropped.
 * Returns undefined when nothing usable is set, which means no restriction beyond "free and tool-capable".
 */
export function parseAllowedModels(value: string | undefined): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * Reads the owner's default model (`NLT_AGENT_DEFAULT_MODEL`) as a preference list of at most one id. The default is
 * only a preference: it is used when it is free, tool-capable and allowed right now, and otherwise the usual order
 * applies. Blank means no default.
 */
export function parseDefaultModel(value: string | undefined): string[] {
  const id = typeof value === "string" ? value.trim() : "";
  return id.length > 0 ? [id] : [];
}

/** Reads and shape-checks the public catalog. Throws if it cannot be read or is not a model list. */
export async function fetchGatewayCatalog(
  options: { fetchImpl?: typeof fetch; url?: string; timeoutMs?: number } = {},
): Promise<GatewayCatalogModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(options.url ?? GATEWAY_MODELS_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new NoFreeModelError(`Model catalog request failed with status ${response.status}`);
    const body: unknown = await response.json();
    const data = body !== null && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) throw new NoFreeModelError("Model catalog response was not a model list");
    return data.filter((item): item is GatewayCatalogModel => item !== null && typeof item === "object");
  } catch (error) {
    if (error instanceof NoFreeModelError) throw error;
    throw new NoFreeModelError(`Model catalog could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface PickOptions extends SelectOptions {
  fetchImpl?: typeof fetch;
  url?: string;
  timeoutMs?: number;
  /**
   * A specific model the caller wants (for example set by the owner). It is used only if it is free right now
   * and also passes the other filters (by default it must have the "tool-use" tag; set `requireToolUse: false`
   * to allow one without); otherwise this throws and does not substitute a different model.
   */
  requested?: string;
}

/** Chooses the model to use, reading the live catalog. Throws NoFreeModelError rather than ever returning a priced model. */
export async function pickFreeModel(options: PickOptions = {}): Promise<GatewayCatalogModel> {
  const catalog = await fetchGatewayCatalog(options);
  const free = selectFreeModels(catalog, options);
  if (options.requested !== undefined) {
    const match = free.find((model) => model.id === options.requested);
    if (!match) {
      // Say which rule refused it: the owner's allow-list, or "not free / not tool-capable right now".
      const requested = options.requested;
      const refusedOnlyByAllowList =
        options.allowed !== undefined &&
        options.allowed.length > 0 &&
        selectFreeModels(catalog, { ...options, allowed: undefined }).some((model) => model.id === requested);
      throw new NoFreeModelError(
        refusedOnlyByAllowList
          ? `The requested model is not in the owner's allowed models (NLT_AGENT_MODELS): ${requested}`
          : `The requested model is not a free model right now: ${requested}`,
      );
    }
    return match;
  }
  const best = free[0];
  if (!best) {
    throw new NoFreeModelError(
      options.allowed && options.allowed.length > 0
        ? "None of the allowed models (NLT_AGENT_MODELS) is a free model with tool support right now"
        : "No free language model with tool support is listed right now",
    );
  }
  return best;
}
