import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	ImageContent,
	SystemOneCompat,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";

/** A System One image asset: base64 file bytes, referenced by its name from the state. */
interface SystemOneImageAsset {
	type: "image";
	format: "png" | "jpeg";
	data_base64: string;
}

/** An image in the state, OpenRouter's form. */
interface SystemOneImageUrlPart {
	type: "image_url";
	image_url: { url: string };
}

/** TypeSafe System One request body without the transport-specific envelope. */
export interface SystemOneWireRequest {
	/** The context state, or with images a list of the images or their asset names followed by the state. */
	state: unknown;
	questions: Record<string, unknown>;
	/** Images as System One assets, keyed by the names the state references. */
	assets?: Record<string, SystemOneImageAsset>;
	/** Images as data URLs, Clef's extension to System One. */
	images?: string[];
}

/**
 * How a service takes images (`SystemOneCompat.imageInput`):
 * - `assets`: TypeSafe's `assets` map, `{ "<image-1>": { type: "image", format, data_base64 } }`,
 *   with the names placed before the state: `state: ["<image-1>", state]`. PNG and JPEG only.
 * - `images`: Clef's `images` list of data URLs, which the model reads before the state.
 *   PNG, JPEG, and WebP, at most four.
 * - `state-image-urls`: OpenRouter's form, data URL parts placed before the state:
 *   `state: [{ type: "image_url", image_url: { url } }, state]`. OpenRouter accepts this for every
 *   model, and drops `assets` silently.
 */
export type SystemOneImageInput = NonNullable<SystemOneCompat["imageInput"]>;

/** System One compatibility settings with every field resolved. */
export type ResolvedSystemOneCompat = Required<SystemOneCompat>;

/** TypeSafe's opt-in header for its experimental image input. */
const IMAGE_OPT_IN_HEADERS = { "TypeSafe-Danger-Zone-Images": "true" };

/** Differences between services that serve System One models. */
export interface SystemOneTransport {
	/** Classifier API implemented by this transport. */
	api: ClassifierApi;
	/** Service name used in error messages. */
	label: string;
	/** Compatibility settings for models that do not set them in `compat`. */
	detectCompat(model: ClassifierModel<ClassifierApi>): ResolvedSystemOneCompat;
	/** Absolute request URL. */
	url(model: ClassifierModel<ClassifierApi>): URL;
	/** Wraps the System One request in the service's request envelope. */
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): unknown;
	/** Extracts the System One output (`{ answers, usage }`) from the service's response envelope. */
	output(body: unknown): Record<string, unknown>;
}

function probabilities(label: string, value: unknown, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		Object.entries(value).map(([key, probability]) => [
			key,
			requiredNumber(label, probability, `probability for ${id}.${key}`),
		]),
	);
}

function parseAnswers(label: string, value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
	const answers: Array<[string, ClassifierAnswer]> = [];
	for (const [id, question] of Object.entries(context.questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (answer.type !== "choice" || typeof answer.choice !== "string") {
				throw new Error(`${label} did not return a choice answer for ${id}`);
			}
			answers.push([
				id,
				{
					type: "choice",
					choice: answer.choice,
					probabilities: probabilities(label, answer.probabilities, id),
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else if (question.type === "score") {
			if (answer.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
			answers.push([
				id,
				{
					type: "score",
					score: requiredNumber(label, answer.score, `score for ${id}`),
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else {
			if (answer.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
			answers.push([
				id,
				{
					type: "bool",
					probability: requiredNumber(label, answer.noul, `probability for ${id}`),
				},
			]);
		}
	}
	return Object.fromEntries(answers);
}

const ASSET_FORMATS: Record<string, SystemOneImageAsset["format"]> = { "image/png": "png", "image/jpeg": "jpeg" };
const DATA_URL_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Clef accepts at most this many images per request. */
const MAX_DATA_URL_IMAGES = 4;

/** Adds the context images to `request` in the service's form. */
function addImages(
	label: string,
	model: ClassifierModel<ClassifierApi>,
	input: SystemOneImageInput,
	images: ImageContent[],
	request: SystemOneWireRequest,
): void {
	if (input === "images") {
		if (images.length > MAX_DATA_URL_IMAGES) {
			throw new Error(
				`${label} accepts at most ${MAX_DATA_URL_IMAGES} images for ${model.id}, got ${images.length}`,
			);
		}
		request.images = images.map((image) => {
			if (!DATA_URL_TYPES.has(image.mimeType)) {
				throw new Error(`${label} accepts PNG, JPEG, and WebP images for ${model.id}, got ${image.mimeType}`);
			}
			return `data:${image.mimeType};base64,${image.data}`;
		});
		return;
	}
	if (input === "state-image-urls") {
		// OpenRouter validates the images against the model that serves the request.
		const parts = images.map(
			(image): SystemOneImageUrlPart => ({
				type: "image_url",
				image_url: { url: `data:${image.mimeType};base64,${image.data}` },
			}),
		);
		request.state = [...parts, request.state];
		return;
	}
	const assets: Record<string, SystemOneImageAsset> = {};
	images.forEach((image, index) => {
		const format = ASSET_FORMATS[image.mimeType];
		if (!format) throw new Error(`${label} accepts PNG and JPEG images for ${model.id}, got ${image.mimeType}`);
		assets[`<image-${index + 1}>`] = { type: "image", format, data_base64: image.data };
	});
	request.assets = assets;
	// Every asset must be referenced from the request. The names go before the state, where Clef
	// also places its images.
	request.state = [...Object.keys(assets), request.state];
}

/** Maps public `bool` questions to TypeSafe's wire-level `noul` type. */
function wireRequest(context: ClassifierContext): SystemOneWireRequest {
	return {
		state: context.state,
		questions: Object.fromEntries(
			Object.entries(context.questions).map(([id, question]) => [
				id,
				question.type === "bool" ? { ...question, type: "noul" } : question,
			]),
		),
	};
}

/** Runs one System One classification over the given transport. */
export async function classifySystemOne(
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== transport.api) throw new Error(`Unsupported classifier API: ${model.api}`);
		const request = wireRequest(context);
		let requestOptions = options;
		if (context.images?.length) {
			if (!model.input.includes("image")) {
				throw new Error(`${transport.label} does not support image input for ${model.id}`);
			}
			const detected = transport.detectCompat(model);
			const imageInput = model.compat?.imageInput ?? detected.imageInput;
			addImages(transport.label, model, imageInput, context.images, request);
			if (model.compat?.sendImageOptInHeader ?? detected.sendImageOptInHeader) {
				requestOptions = { ...options, headers: { ...IMAGE_OPT_IN_HEADERS, ...options?.headers } };
			}
		}
		const body = await postClassifierRequest(
			transport.label,
			transport.url(model),
			model,
			transport.payload(model, request),
			requestOptions,
		);
		const result = transport.output(body);
		// Set before parsing answers: a request with malformed answers was still billed.
		const usage = parseClassifierUsage(result.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(transport.label, result.answers, context);
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${transport.label} error`);
		return output;
	}
}
