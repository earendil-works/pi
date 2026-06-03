export interface Model {
  id: string;
  name: string;
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
    return parseSchema1(parsed);
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
    models.push({ id: item.id, name });
  }

  return models;
}

function parseFlatModelsArray(arr: unknown[]): Model[] {
  const models: Model[] = [];

  for (const item of arr) {
    if (!isObject(item) || typeof item.id !== "string") {
      continue;
    }

    const name = getModelName(item);
    models.push({ id: item.id, name });
  }

  return models;
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
