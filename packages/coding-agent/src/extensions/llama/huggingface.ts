import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_HUGGING_FACE_URL = "https://huggingface.co";
const QUANTIZATION_PATTERN =
	/(?:^|[-_.])((?:UD-)?(?:IQ\d(?:_[A-Z0-9]+)+|Q\d(?:_[A-Z0-9]+)+|BF16|F16|F32|MXFP\d(?:_[A-Z0-9]+)*))$/iu;
const SHARD_SUFFIX_PATTERN = /-\d{5}-of-\d{5}$/u;

export interface HuggingFaceModel {
	id: string;
	downloads: number;
}

export interface HuggingFaceQuantization {
	name: string;
	size?: number;
}

export interface HuggingFaceModelDetails {
	id: string;
	gated: false | "auto" | "manual";
	quantizations: HuggingFaceQuantization[];
}

function payloadError(payload: unknown, fallback: string): string {
	if (typeof payload !== "object" || payload === null) return fallback;
	const error = (payload as { error?: unknown }).error;
	return typeof error === "string" && error ? error : fallback;
}

function parseRateLimitDelay(value: string | null): number | undefined {
	const match = value?.match(/(?:^|;)t=(\d+)/u);
	return match ? Number(match[1]) : undefined;
}

async function readToken(path: string): Promise<string | undefined> {
	try {
		const token = (await readFile(path, "utf8")).trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

export async function findHuggingFaceToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const fromEnvironment = env.HF_TOKEN?.trim();
	if (fromEnvironment) return fromEnvironment;

	const paths = [
		env.HF_TOKEN_PATH,
		env.HF_HOME ? join(env.HF_HOME, "token") : undefined,
		env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "huggingface", "token") : undefined,
		join(homedir(), ".cache", "huggingface", "token"),
	].filter((path): path is string => Boolean(path));
	for (const path of new Set(paths)) {
		const token = await readToken(path);
		if (token) return token;
	}
	return undefined;
}

export class HuggingFaceClient {
	private readonly token: string | undefined;
	private readonly baseUrl: string;

	constructor(token?: string, baseUrl = DEFAULT_HUGGING_FACE_URL) {
		this.token = token;
		this.baseUrl = baseUrl.replace(/\/+$/u, "");
	}

	private async request(path: string, signal?: AbortSignal): Promise<unknown> {
		const headers = new Headers();
		if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
		const timeout = AbortSignal.timeout(15_000);
		const response = await fetch(`${this.baseUrl}${path}`, {
			headers,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (!response.ok) {
			const fallback = `Hugging Face returned HTTP ${response.status}`;
			if (response.status === 429) {
				const delay =
					Number(response.headers.get("retry-after")) || parseRateLimitDelay(response.headers.get("ratelimit"));
				throw new Error(
					delay ? `Hugging Face rate limit reached; retry in ${delay}s` : "Hugging Face rate limit reached",
				);
			}
			throw new Error(payloadError(payload, fallback));
		}
		return payload;
	}

	async search(query: string, signal?: AbortSignal): Promise<HuggingFaceModel[]> {
		const params = new URLSearchParams({
			search: query,
			filter: "gguf",
			sort: "downloads",
			direction: "-1",
			limit: "20",
		});
		const payload = await this.request(`/api/models?${params}`, signal);
		if (!Array.isArray(payload)) throw new Error("Hugging Face returned invalid search results");
		return payload.flatMap((value) => {
			if (typeof value !== "object" || value === null || typeof (value as { id?: unknown }).id !== "string")
				return [];
			const model = value as { id: string; downloads?: unknown };
			return [{ id: model.id, downloads: typeof model.downloads === "number" ? model.downloads : 0 }];
		});
	}

	async details(id: string, signal?: AbortSignal): Promise<HuggingFaceModelDetails> {
		const encodedId = id.split("/").map(encodeURIComponent).join("/");
		const payload = await this.request(`/api/models/${encodedId}?blobs=true`, signal);
		if (typeof payload !== "object" || payload === null) {
			throw new Error("Hugging Face returned invalid model details");
		}
		const model = payload as { id?: unknown; gated?: unknown; siblings?: unknown };
		const sizes = new Map<string, { total: number; complete: boolean }>();
		if (Array.isArray(model.siblings)) {
			for (const value of model.siblings) {
				if (typeof value !== "object" || value === null) continue;
				const file = value as { rfilename?: unknown; size?: unknown };
				if (typeof file.rfilename !== "string" || !file.rfilename.toLowerCase().endsWith(".gguf")) continue;
				const filename = file.rfilename.split("/").at(-1)!;
				if (filename.toLowerCase().startsWith("mmproj")) continue;
				const stem = filename.slice(0, -5).replace(SHARD_SUFFIX_PATTERN, "");
				const quantization = stem.match(QUANTIZATION_PATTERN)?.[1]?.toUpperCase();
				if (!quantization) continue;
				const current = sizes.get(quantization) ?? { total: 0, complete: true };
				if (typeof file.size === "number") current.total += file.size;
				else current.complete = false;
				sizes.set(quantization, current);
			}
		}
		const quantizations = [...sizes]
			.map(([name, size]) => ({ name, size: size.complete ? size.total : undefined }))
			.sort((left, right) => {
				if (left.name === "Q4_K_M") return -1;
				if (right.name === "Q4_K_M") return 1;
				return (
					(left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER) ||
					left.name.localeCompare(right.name)
				);
			});
		return {
			id: typeof model.id === "string" ? model.id : id,
			gated: model.gated === "auto" || model.gated === "manual" ? model.gated : false,
			quantizations,
		};
	}
}
