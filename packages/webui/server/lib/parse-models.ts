export interface Model {
  id: string;
  name: string;
  // Model's context window in tokens, e.g. 200_000 for Sonnet 4.
  // Reflected to the webui so the topbar can render "used / total"
  // context usage. Optional because older models.json files / untyped
  // models omit it — the UI gracefully falls back to "used only".
  contextWindow?: number;
}

export interface Provider {
  name: string;
  models: Model[];
}

export interface ParsedProviders {
  providers: Provider[];
}

export function parseModelsJson(jsonStr: string): ParsedProviders {
  if (!jsonStr || typeof jsonStr !== "string") {
    return { providers: [] };
  }

  const trimmed = jsonStr.trim();
  if (trimmed === "") {
    return { providers: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { providers: [] };
  }

  // Schema 3: [{ name, models }] - array of providers
  if (Array.isArray(parsed)) {
    return parseSchema3(parsed);
  }

  if (!isObject(parsed)) {
    return { providers: [] };
  }

  // Schema 1: { providers: [{ name, models }] }
  if (hasProvidersProperty(parsed)) {
    const providersValue = (parsed as { providers: unknown }).providers;
    // Schema 1a: providers is array
    if (Array.isArray(providersValue)) {
      return parseSchema1(parsed);
    }
    // Schema 4: providers is { [name]: config { models, baseUrl, ... } }
    if (isObject(providersValue)) {
      return parseSchema4(providersValue);
    }
  }

  // Schema 2: { [name]: models[] } - flat provider structure
  return parseSchema2(parsed);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProvidersProperty(value: unknown): value is { providers?: unknown } {
  return isObject(value) && "providers" in value;
}

function parseSchema1(data: { providers?: unknown }): ParsedProviders {
  const providers: Provider[] = [];

  if (!Array.isArray(data.providers)) {
    return { providers: [] };
  }

  for (const item of data.providers) {
    if (!isObject(item) || typeof item.name !== "string") {
      continue;
    }

    const models = parseModelsArray(item.models);
    providers.push({
      name: item.name,
      models,
    });
  }

  return { providers };
}

function parseSchema2(data: Record<string, unknown>): ParsedProviders {
  const providers: Provider[] = [];

  for (const [name, models] of Object.entries(data)) {
    if (!Array.isArray(models)) {
      continue;
    }

    const parsedModels = parseFlatModelsArray(models);
    providers.push({
      name,
      models: parsedModels,
    });
  }

  return { providers };
}

function parseSchema4(providers: Record<string, unknown>): ParsedProviders {
  const result: Provider[] = [];
  for (const [name, config] of Object.entries(providers)) {
    if (!isObject(config)) continue;
    const models = parseModelsArray(config.models);
    result.push({ name, models });
  }
  return { providers: result };
}

function parseSchema3(arr: unknown[]): ParsedProviders {
  const providers: Provider[] = [];

  for (const item of arr) {
    if (!isObject(item) || typeof item.name !== "string") {
      continue;
    }

    const models = parseModelsArray(item.models);
    providers.push({
      name: item.name,
      models,
    });
  }

  return { providers };
}

function parseModelsArray(value: unknown): Model[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const models: Model[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== "string") {
      continue;
    }

    const name = getModelName(item);
    const contextWindow = getContextWindow(item);
    models.push({
      id: item.id,
      name,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    });
  }

  return models;
}

function parseFlatModelsArray(arr: unknown[]): Model[] {
  if (!Array.isArray(arr)) {
    return [];
  }

  const models: Model[] = [];
  for (const item of arr) {
    if (!isObject(item) || typeof item.id !== "string") {
      continue;
    }

    const name = getModelName(item);
    const contextWindow = getContextWindow(item);
    models.push({
      id: item.id,
      name,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    });
  }

  return models;
}

function getContextWindow(model: Record<string, unknown>): number | undefined {
  // Accept either the canonical `contextWindow` (matches ModelDefinition
  // in server/index.ts) or `context_window`. Invalid / non-numeric /
  // non-positive inputs resolve to undefined so the UI can drop to a
  // "used only" chip rather than display a misleading denominator.
  const raw = (model as { contextWindow?: unknown; context_window?: unknown }).contextWindow
    ?? (model as { context_window?: unknown }).context_window;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return raw;
}

function getModelName(model: Record<string, unknown>): string {
  if (typeof model.name === "string" && model.name !== "") {
    return model.name;
  }
  if (typeof model.label === "string" && model.label !== "") {
    return model.label;
  }
  return model.id as string;
}
