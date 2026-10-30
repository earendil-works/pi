/**
 * `models.*` for code mode scripts, copied from the coding agent's code mode: the model catalog, and classifier and
 * image model calls.
 *
 * The catalog functions are host globals, journaled like any global. `models.classify()` and `models.generateImages()`
 * are paid effects, so each runs as an internal tool (`callers: ["tools"]`, a reserved name, hidden from scripts'
 * tool listings): a nested durable call with its own task, live row, abort, usage accounting, and replay policy. The
 * code mode tool turns a script's call of the global into a call of that tool.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type {
	AnyModel,
	ClassifierContext,
	ImagesContext,
	Models,
	ModelType,
	ModelTypeMap,
	Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";

/** Reserved names of code mode's internal tools; they are never listed to scripts or the model. */
export const CODEMODE_INTERNAL_PREFIX = "pi.codemode.";
export const CLASSIFY_TOOL = `${CODEMODE_INTERNAL_PREFIX}models.classify`;
export const GENERATE_IMAGES_TOOL = `${CODEMODE_INTERNAL_PREFIX}models.generateImages`;

/** The global a script calls, by internal tool. */
export const MODEL_CALLS: Readonly<Record<string, string>> = {
	"models.classify": CLASSIFY_TOOL,
	"models.generateImages": GENERATE_IMAGES_TOOL,
};

/** The catalog functions, host globals of the `models` namespace. */
export const CATALOG_GLOBALS = [
	"models.getModelsOfType",
	"models.getAvailableOfType",
	"models.getModelOfType",
] as const;

/** `models.classify()` and `models.generateImages()` calls one script may have in flight; the rest wait. */
export const MAX_CONCURRENT_MODEL_CALLS = 4;

const MODEL_TYPES: ReadonlySet<string> = new Set<ModelType>(["chat", "image", "classifier"]);

export const MODELS_DESCRIPTION = [
	"`models` (all functions return promises):",
	'- `models.getModelsOfType(type, provider?)`, `models.getAvailableOfType(type, provider?)` (configured auth only), `models.getModelOfType(type, provider, id)`: the catalog; `type` is "chat", "image", or "classifier".',
	'- `models.classify(model, { state: { ... }, images?: [{ type: "image", data, mimeType }], questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } })` resolves to `{ answers: { <id>: ... }, stopReason, errorMessage?, usage? }`.',
	'- `models.generateImages(model, { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data, mimeType }] })` resolves to `{ output: [image blocks], stopReason, errorMessage?, usage? }`; show each image with `image(block)`.',
	`At most ${MAX_CONCURRENT_MODEL_CALLS} classify/generateImages calls run at once; more wait.`,
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A script value in an error message: `undefined`, `a string`, `an array`, or its keys (`{ prompt }`). */
function describeValue(value: unknown): string {
	if (value === undefined || value === null) return String(value);
	if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
	if (typeof value === "object") {
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		return `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }`;
	}
	return typeof value === "string" ? "a string" : `a ${typeof value}`;
}

/** `an image`, `a classifier`. */
function withArticle(word: string): string {
	return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

function toModelType(value: unknown): ModelType {
	if (typeof value === "string" && MODEL_TYPES.has(value)) return value as ModelType;
	throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
}

function toProvider(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("provider must be a string");
	return value;
}

/** Catalog entry for scripts. `headers` is dropped because configured headers can carry credentials. */
function toModelInfo(model: AnyModel): JsonValue {
	const info: Record<string, unknown> = { ...model };
	delete info.headers;
	return JSON.parse(JSON.stringify(info)) as JsonValue;
}

/** The catalog functions: what a script's call of `name` with `args` (the argument list) resolves to. */
export async function catalogCall(
	name: string,
	args: unknown,
	models: Models,
	context: Context,
): Promise<JsonValue | undefined> {
	const list = Array.isArray(args) ? args : [];
	const [type, provider, id] = list;
	if (name === "models.getModelsOfType")
		return models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo);
	if (name === "models.getAvailableOfType") {
		const available = await models.getAvailableOfType(toModelType(type), toProvider(provider), {
			...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
		});
		return available.map(toModelInfo);
	}
	if (typeof provider !== "string" || typeof id !== "string") {
		throw new Error(
			`models.getModelOfType(type, provider, id) expects three strings, got (${list.map(describeValue).join(", ")}). The provider and the id are separate arguments, for example models.getModelOfType("classifier", "typesafe", "jev-latest").`,
		);
	}
	const model = models.getModelOfType(toModelType(type), provider, id);
	return model === undefined ? undefined : toModelInfo(model);
}

const CLASSIFIER_CONTEXT_SHAPE =
	'{ state: { ... }, images?: [{ type: "image", data: <base64>, mimeType }], questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }';

/** Check a script's classifier context, so mistakes fail with the expected shape instead of a provider error. */
function checkClassifierContext(context: unknown): ClassifierContext {
	const fail = (problem: string) =>
		new Error(`models.classify() ${problem}. Expected context: ${CLASSIFIER_CONTEXT_SHAPE}.`);
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	if (!isRecord(context.state)) throw fail(`context.state must be an object, got ${describeValue(context.state)}`);
	const { images } = context;
	if (images !== undefined) {
		if (!Array.isArray(images)) throw fail(`context.images must be an array, got ${describeValue(images)}`);
		images.forEach((image: unknown, index) => {
			if (
				!isRecord(image) ||
				image.type !== "image" ||
				typeof image.data !== "string" ||
				typeof image.mimeType !== "string"
			) {
				throw fail(`context.images[${index}] must be an image block, got ${describeValue(image)}`);
			}
		});
	}
	const { questions } = context;
	if (!isRecord(questions) || Object.keys(questions).length === 0) {
		throw fail(`context.questions must map question IDs to questions, got ${describeValue(questions)}`);
	}
	const isStrings = (values: unknown[]) => values.length > 0 && values.every((value) => typeof value === "string");
	for (const [id, question] of Object.entries(questions)) {
		const at = `context.questions.${id}`;
		if (!isRecord(question)) throw fail(`${at} must be a question object, got ${describeValue(question)}`);
		if (typeof question.instructions !== "string") throw fail(`${at}.instructions must be a string`);
		const { criteria } = question;
		if (question.type === "choice") {
			if (!isRecord(criteria) || !isStrings(Object.values(criteria))) {
				throw fail(`${at} is a "choice" question, so criteria must map each label to its meaning`);
			}
		} else if (question.type === "score") {
			if (!Array.isArray(criteria) || !isStrings(criteria)) {
				throw fail(`${at} is a "score" question, so criteria must list the levels as strings, lowest first`);
			}
		} else if (question.type === "bool") {
			if (!isRecord(criteria) || typeof criteria.true !== "string" || typeof criteria.false !== "string") {
				throw fail(`${at} is a "bool" question, so criteria must be { true: string, false: string }`);
			}
		} else {
			throw fail(`${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`);
		}
	}
	return context as unknown as ClassifierContext;
}

/** Check a script's image context, so mistakes such as `{ prompt }` fail with the expected shape. */
function checkImagesContext(context: unknown): ImagesContext {
	const fail = (problem: string) =>
		new Error(
			`models.generateImages() ${problem}. Expected context: { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data: <base64>, mimeType } references] }.`,
		);
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	const { input } = context;
	if (!Array.isArray(input) || input.length === 0) {
		throw fail(`context.input must be a non-empty array of blocks, got ${describeValue(input)}`);
	}
	input.forEach((block: unknown, index) => {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return;
		if (
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		)
			return;
		throw fail(`context.input[${index}] must be a text or image block, got ${describeValue(block)}`);
	});
	return context as unknown as ImagesContext;
}

/**
 * Resolve the script's model by provider and id only, so a script-supplied baseUrl or headers never receive the
 * credentials, with errors that say what to do.
 */
function resolveModel<TType extends "classifier" | "image">(
	name: string,
	type: TType,
	model: unknown,
	models: Models,
): ModelTypeMap[TType] {
	const listHint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`;
	if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
		const undefinedHint =
			model === undefined || model === null
				? " models.getModelOfType() returns undefined for an unknown provider or id."
				: "";
		throw new Error(
			`${name}() expects ${withArticle(type)} model as its first argument, got ${describeValue(model)}.${undefinedHint} ${listHint}`,
		);
	}
	const { provider, id } = model;
	const resolved = models.getModelOfType(type, provider, id);
	if (resolved !== undefined) return resolved;
	const actualType = [...MODEL_TYPES].find(
		(other) => other !== type && models.getModelOfType(other as ModelType, provider, id) !== undefined,
	);
	throw new Error(
		actualType
			? `"${provider}/${id}" is ${withArticle(actualType)} model, not ${withArticle(type)} model. ${listHint}`
			: `Unknown ${type} model "${provider}/${id}". ${listHint}`,
	);
}

const ModelCallParameters = Type.Object({ model: Type.Unknown(), context: Type.Unknown() });

/** The result of a model call as the tool returns it: the whole result for the script, usage counted by the Harness. */
function modelResult(
	label: string,
	result: { stopReason: string; errorMessage?: string; usage?: Usage },
	value: unknown,
) {
	const ok = result.stopReason === "stop";
	return {
		output: [
			{
				type: "text" as const,
				text: ok ? `${label} done` : `${label} ${result.stopReason}: ${result.errorMessage ?? ""}`,
			},
		],
		structuredOutput: JSON.parse(JSON.stringify(value)) as JsonValue,
		...(ok ? {} : { isError: true }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
	};
}

/** The internal tools behind `models.classify()` and `models.generateImages()`. */
export function createModelTools(): ToolRegistration[] {
	const classify = defineTool({
		name: CLASSIFY_TOOL,
		description: "models.classify() of code mode scripts.",
		parameters: ModelCallParameters,
		structuredOutputSchema: Type.Unknown(),
		callers: ["tools"],
		execute: async (args, api, context) => {
			const model = resolveModel("models.classify", "classifier", args.model, api.models);
			const checked = checkClassifierContext(args.context);
			const result = await api.models.classify(model, checked, {
				telemetry: context.telemetry,
				...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
			});
			return modelResult(`classify ${model.provider}/${model.id}`, result, result);
		},
	});
	const generateImages = defineTool({
		name: GENERATE_IMAGES_TOOL,
		description: "models.generateImages() of code mode scripts.",
		parameters: ModelCallParameters,
		structuredOutputSchema: Type.Unknown(),
		callers: ["tools"],
		execute: async (args, api, context) => {
			const model = resolveModel("models.generateImages", "image", args.model, api.models);
			const checked = checkImagesContext(args.context);
			const result = await api.models.generateImages(model, checked, {
				telemetry: context.telemetry,
				...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
			});
			return modelResult(`generateImages ${model.provider}/${model.id}`, result, result);
		},
	});
	return [classify as unknown as ToolRegistration, generateImages as unknown as ToolRegistration];
}
