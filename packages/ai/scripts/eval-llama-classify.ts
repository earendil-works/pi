/**
 * Evaluates llama-cpp-classify with a llama-server model on JevBench's public items.
 *
 * Usage:
 *   node scripts/eval-llama-classify.ts --jevbench ~/src/jevbench --url http://127.0.0.1:8080 \
 *     [--model <id>] [--tiers easy,original,hard] [--limit N] [--out results.jsonl]
 *
 * `--model` is sent as the model ID, which selects the model on a llama.cpp router.
 * Rerun with the same `--out` file per model or prompt change and compare items pairwise.
 *
 * JevBench (https://github.com/fstandhartinger/jevbench, MIT) is not vendored; pass a checkout.
 * Every item is classified at temperature 1. Other temperatures are derived offline:
 * softmax(l / T) equals p^(1/T) renormalized, so calibration at several temperatures needs one run.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { classify } from "../src/api/llama-cpp-classify.ts";
import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierModel,
	ClassifierQuestion,
	JsonObject,
	JsonValue,
} from "../src/types.ts";

interface JevBenchItem {
	id: string;
	family: string;
	state: string | JsonObject;
	question: {
		type: "choice" | "noul" | "score";
		instructions: JsonValue;
		criteria?: JsonValue;
	};
	expected: string | number;
}

interface ItemResult {
	model: string;
	tier: string;
	id: string;
	type: ClassifierQuestion["type"];
	correct: boolean;
	/** Probabilities at T=1 in option order, when the answer exposes a distribution. */
	probabilities?: number[];
	/** Index of the gold answer in `probabilities`. */
	gold?: number;
	latencyMs: number;
	error?: string;
}

const TEMPERATURES = [1, 1.5, 2, 3];
const EPSILON = 1e-12;

const { values } = parseArgs({
	options: {
		jevbench: { type: "string" },
		url: { type: "string", default: "http://127.0.0.1:8080" },
		model: { type: "string", default: "local" },
		tiers: { type: "string", default: "easy,original,hard" },
		limit: { type: "string" },
		out: { type: "string" },
	},
});
if (!values.jevbench) throw new Error("--jevbench <checkout> is required");

const text = (value: JsonValue | undefined): string =>
	typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);

function toContext(item: JevBenchItem): ClassifierContext {
	const state: JsonObject = typeof item.state === "string" ? { text: item.state } : item.state;
	const { question } = item;
	let converted: ClassifierQuestion;
	if (question.type === "choice") {
		const criteria = question.criteria as Record<string, JsonValue>;
		converted = {
			type: "choice",
			instructions: text(question.instructions),
			criteria: Object.fromEntries(Object.entries(criteria).map(([key, value]) => [key, text(value)])),
		};
	} else if (question.type === "score") {
		converted = {
			type: "score",
			instructions: text(question.instructions),
			criteria: (question.criteria as JsonValue[]).map(text),
		};
	} else {
		const criteria = (question.criteria ?? {}) as Record<string, JsonValue>;
		converted = {
			type: "bool",
			instructions: text(question.instructions),
			criteria: { true: text(criteria.true), false: text(criteria.false) },
		};
	}
	return { state, questions: { q: converted } };
}

function score(item: JevBenchItem, answer: ClassifierAnswer): Pick<ItemResult, "correct" | "probabilities" | "gold"> {
	if (answer.type === "choice") {
		const keys = Object.keys(answer.probabilities);
		return {
			correct: answer.choice === item.expected,
			probabilities: keys.map((key) => answer.probabilities[key]!),
			gold: keys.indexOf(String(item.expected)),
		};
	}
	if (answer.type === "bool") {
		return {
			correct: answer.probability > 0.5 === (item.expected === "yes"),
			probabilities: [answer.probability, 1 - answer.probability],
			gold: item.expected === "yes" ? 0 : 1,
		};
	}
	return { correct: Math.round(answer.score) === Number(item.expected) };
}

function withTemperature(probabilities: readonly number[], temperature: number): number[] {
	const powered = probabilities.map((probability) => probability ** (1 / temperature));
	const total = powered.reduce((sum, value) => sum + value, 0);
	return powered.map((value) => value / total);
}

/** Top-label expected calibration error over 10 equal-width confidence bins, plus mean NLL of the gold answer. */
function calibration(results: readonly ItemResult[], temperature: number): { ece: number; nll: number } {
	const scored = results.filter((result) => result.probabilities && result.gold !== undefined && result.gold >= 0);
	if (scored.length === 0) return { ece: Number.NaN, nll: Number.NaN };
	const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
	let nll = 0;
	for (const result of scored) {
		const probabilities = withTemperature(result.probabilities!, temperature);
		const confidence = Math.max(...probabilities);
		const bin = bins[Math.min(9, Math.floor(confidence * 10))]!;
		bin.count++;
		bin.confidence += confidence;
		bin.correct += probabilities.indexOf(confidence) === result.gold ? 1 : 0;
		nll -= Math.log(Math.max(EPSILON, probabilities[result.gold!]!));
	}
	const ece = bins.reduce((sum, bin) => sum + (bin.count === 0 ? 0 : Math.abs(bin.correct - bin.confidence)), 0);
	return { ece: ece / scored.length, nll: nll / scored.length };
}

const model: ClassifierModel<"llama-cpp-classify"> = {
	type: "classifier",
	id: values.model!,
	name: values.model!,
	api: "llama-cpp-classify",
	provider: "llama.cpp",
	baseUrl: values.url!,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
};

const tiers = values.tiers!.split(",");
const limit = values.limit ? Number(values.limit) : undefined;
const items = new Map(
	tiers.map((tier) => {
		const lines = readFileSync(join(values.jevbench!, "datasets", "public", `${tier}.jsonl`), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "");
		return [tier, lines.slice(0, limit).map((line) => JSON.parse(line) as JevBenchItem)];
	}),
);

const results: ItemResult[] = [];
for (const [tier, tierItems] of items) {
	for (const [index, item] of tierItems.entries()) {
		const started = performance.now();
		const output = await classify(model, toContext(item), { maxRetries: 0 });
		const latencyMs = performance.now() - started;
		const answer = output.answers.q;
		const result: ItemResult = answer
			? { model: model.id, tier, id: item.id, type: answer.type, latencyMs, ...score(item, answer) }
			: {
					model: model.id,
					tier,
					id: item.id,
					type: item.question.type === "noul" ? "bool" : item.question.type,
					correct: false,
					latencyMs,
					error: output.errorMessage,
				};
		results.push(result);
		if (values.out) appendFileSync(values.out, `${JSON.stringify(result)}\n`);
		process.stderr.write(
			`\r${tier} ${index + 1}/${tierItems.length}${result.error ? ` error: ${result.error}\n` : ""}`,
		);
	}
	process.stderr.write("\n");
}

const format = (value: number, digits = 3): string => (Number.isNaN(value) ? "-" : value.toFixed(digits));
const header = [
	"tier",
	"accuracy",
	...TEMPERATURES.map((temperature) => `ECE T=${temperature}`),
	...TEMPERATURES.map((temperature) => `NLL T=${temperature}`),
	"median ms",
	"errors",
];
console.log(`\nModel: ${values.model} at ${values.url}\n`);
console.log(`| ${header.join(" | ")} |`);
console.log(`|${header.map(() => " --- ").join("|")}|`);
for (const tier of [...tiers, "all"]) {
	const own = tier === "all" ? results : results.filter((result) => result.tier === tier);
	const latencies = own.map((result) => result.latencyMs).sort((a, b) => a - b);
	const row = [
		tier,
		`${own.filter((result) => result.correct).length}/${own.length}`,
		...TEMPERATURES.map((temperature) => format(calibration(own, temperature).ece)),
		...TEMPERATURES.map((temperature) => format(calibration(own, temperature).nll)),
		format(latencies[Math.floor(latencies.length / 2)] ?? Number.NaN, 0),
		String(own.filter((result) => result.error).length),
	];
	console.log(`| ${row.join(" | ")} |`);
}
