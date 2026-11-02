// A deterministic corpus of distinct tool-like JSON Schemas with one valid value each: random property names,
// descriptions, leaf constraints, enums, nested objects, arrays and some $defs/$ref. No two schemas are copies.

/** A schema and a value it accepts. */
export interface CorpusItem {
	readonly schema: Record<string, unknown>;
	readonly value: unknown;
}

const SYLLABLES = [
	"ka",
	"lo",
	"mi",
	"re",
	"su",
	"ta",
	"ne",
	"vo",
	"pi",
	"da",
	"ru",
	"xe",
	"bo",
	"fi",
	"gu",
	"ha",
	"jo",
	"ze",
];
const PATTERNS: readonly (readonly [string, string])[] = [
	["^[a-z0-9-]+$", "a-1"],
	["^[A-Za-z0-9._-]+$", "A.b_c"],
	["^\\d{4}-\\d{2}-\\d{2}$", "2026-10-31"],
	["^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "01890a5d-ac96-774b-bcce-b302099a8057"],
	["^#[0-9a-f]{6}$", "#00ff00"],
];

/** `count` distinct schemas, the same for the same seed. */
export function corpus(count: number, seed = 42): CorpusItem[] {
	const random = mulberry32(seed);
	const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
	const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
	const word = () => Array.from({ length: int(2, 4) }, () => pick(SYLLABLES)).join("");
	const sentence = () => `${Array.from({ length: int(4, 12) }, word).join(" ")}.`;

	function leaf(depth: number): [Record<string, unknown>, unknown] {
		const r = random();
		if (r < 0.3) return [{ type: "string", description: sentence() }, word()];
		if (r < 0.4) {
			const min = int(0, 3);
			return [
				{ type: "string", minLength: min, maxLength: min + int(5, 200), description: sentence() },
				"x".repeat(min + 1),
			];
		}
		if (r < 0.47) {
			const [pattern, value] = pick(PATTERNS);
			return [{ type: "string", pattern, description: sentence() }, value];
		}
		if (r < 0.55) {
			const values = Array.from({ length: int(2, 5) }, word);
			return [{ type: "string", enum: values, description: sentence() }, values[0]];
		}
		if (r < 0.65) {
			const min = int(0, 10);
			return [{ type: "integer", minimum: min, maximum: min + int(10, 10000), description: sentence() }, min + 1];
		}
		if (r < 0.72) return [{ type: "number", description: sentence() }, random() * 100];
		if (r < 0.8) return [{ type: "boolean", description: sentence() }, random() < 0.5];
		if (r < 0.88) {
			return [{ type: "array", items: { type: "string" }, maxItems: int(1, 50), description: sentence() }, [word()]];
		}
		if (depth < 2) return object(depth + 1, int(2, 5));
		return [{ type: "string", description: sentence() }, word()];
	}

	function object(depth: number, n: number): [Record<string, unknown>, Record<string, unknown>] {
		const properties: Record<string, Record<string, unknown>> = {};
		const value: Record<string, unknown> = {};
		const required: string[] = [];
		for (let i = 0; i < n; i++) {
			const name = word() + (i > 0 ? i : "");
			const [schema, v] = leaf(depth);
			properties[name] = schema;
			if (random() < 0.6) {
				required.push(name);
				value[name] = v;
			} else if (random() < 0.5) value[name] = v;
		}
		const schema: Record<string, unknown> = { type: "object", properties, required };
		if (random() < 0.5) schema.additionalProperties = false;
		return [schema, value];
	}

	const items: CorpusItem[] = [];
	for (let i = 0; i < count; i++) {
		const [schema, value] = object(0, int(2, 10));
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		if (random() < 0.2) {
			// Move one nested object into $defs and reference it, as MCP servers built with zod often do.
			const key = Object.keys(properties).find((k) => properties[k].type === "object");
			if (key !== undefined) {
				const name = `${word()}Def`;
				schema.$defs = { [name]: properties[key] };
				properties[key] = { $ref: `#/$defs/${name}` };
			}
		}
		schema.description = sentence();
		items.push({ schema, value });
	}
	return items;
}

function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
