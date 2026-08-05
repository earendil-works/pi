export interface ModelSearchItem {
	id: string;
	provider: string;
	name?: string;
}

const MODEL_ID_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const CONTEXT_ALIAS_PATTERN = /^(.*)@(\d+(?:\.\d+)?)([km])$/i;

function parseContextAlias(id: string): { base: string; tokens: number } | undefined {
	const match = id.match(CONTEXT_ALIAS_PATTERN);
	if (!match) return undefined;
	const value = Number(match[2]);
	if (!Number.isFinite(value)) return undefined;
	return { base: match[1]!, tokens: value * (match[3]!.toLowerCase() === "m" ? 1_000_000 : 1_000) };
}

/** Sort model IDs naturally, keeping a base model before numeric context aliases. */
export function compareModelIds(left: string, right: string): number {
	const leftAlias = parseContextAlias(left);
	const rightAlias = parseContextAlias(right);
	const baseOrder = MODEL_ID_COLLATOR.compare(leftAlias?.base ?? left, rightAlias?.base ?? right);
	if (baseOrder !== 0) return baseOrder;
	if (!leftAlias) return rightAlias ? -1 : MODEL_ID_COLLATOR.compare(left, right);
	if (!rightAlias) return 1;
	return leftAlias.tokens - rightAlias.tokens || MODEL_ID_COLLATOR.compare(left, right);
}

export function getModelSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${id} ${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/**
 * The /model selector search should rank exact provider-prefixed queries before proxy-provider IDs
 * like openrouter/openai/gpt-5, so keep the bare model ID out of the leading position.
 */
export function getModelSelectorSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}
