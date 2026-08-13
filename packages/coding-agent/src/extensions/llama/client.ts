export type LlamaModelStatus = "unloaded" | "loading" | "loaded" | "downloading" | "sleeping";

export interface LlamaModelInfo {
	id: string;
	aliases?: string[];
	status: {
		value: LlamaModelStatus;
		args?: string[];
		failed?: boolean;
		exit_code?: number;
		progress?: Record<string, { done: number; total: number }>;
	};
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	source?: string;
	meta?: {
		n_ctx?: number;
		n_ctx_train?: number;
		size?: number;
		ftype?: string;
	};
}

export interface LlamaModelsResponse {
	data: LlamaModelInfo[];
	object?: string;
}

export interface LlamaModelEvent {
	model: string;
	event: string;
	data?: unknown;
}

export interface LlamaProgress {
	message: string;
	ratio?: number;
	detail?: string;
}

function errorMessage(payload: unknown, fallback: string): string {
	if (typeof payload !== "object" || payload === null) return fallback;
	const error = (payload as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return fallback;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && message ? message : fallback;
}

function isModelInfo(value: unknown): value is LlamaModelInfo {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { id?: unknown; status?: { value?: unknown } };
	return typeof candidate.id === "string" && typeof candidate.status?.value === "string";
}

function linkSignal(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	if (source.aborted) {
		target.abort(source.reason);
		return () => {};
	}
	const abort = () => target.abort(source.reason);
	source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Cancelled"));
			return;
		}
		const abort = () => {
			clearTimeout(timeout);
			reject(signal?.reason ?? new Error("Cancelled"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function parseLoadProgress(data: unknown): LlamaProgress | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const progress = (data as { progress?: unknown }).progress;
	if (typeof progress !== "object" || progress === null) return undefined;
	const value = progress as { stages?: unknown; current?: unknown; stage?: unknown; value?: unknown };
	const stage =
		typeof value.current === "string" ? value.current : typeof value.stage === "string" ? value.stage : undefined;
	const stages = Array.isArray(value.stages)
		? value.stages.filter((entry): entry is string => typeof entry === "string")
		: [];
	const stageRatio = typeof value.value === "number" ? Math.max(0, Math.min(1, value.value)) : undefined;
	let ratio = stageRatio;
	if (stage && stages.length > 0) {
		const index = stages.indexOf(stage);
		if (index >= 0) ratio = (index + (stageRatio ?? 0)) / stages.length;
	}
	return {
		message: stage ? `Loading ${stage.replaceAll("_", " ")}` : "Loading model",
		ratio,
	};
}

function parseDownloadProgress(data: unknown): LlamaProgress | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const nested = (data as { progress?: unknown }).progress;
	const files = typeof nested === "object" && nested !== null ? nested : data;
	let done = 0;
	let total = 0;
	for (const value of Object.values(files as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value as { done?: unknown; total?: unknown };
		if (typeof entry.done !== "number" || typeof entry.total !== "number") continue;
		done += entry.done;
		total += entry.total;
	}
	if (total <= 0) return undefined;
	return {
		message: "Downloading model",
		ratio: done / total,
		detail: `${formatBytes(done)} / ${formatBytes(total)}`,
	};
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = units[0]!;
	for (let index = 1; index < units.length && value >= 1024; index++) {
		value /= 1024;
		unit = units[index]!;
	}
	return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

export function normalizeLlamaServerUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Server URL must use http or https");
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
	return url.toString().replace(/\/$/u, "");
}

export function llamaInferenceUrl(serverUrl: string): string {
	return `${normalizeLlamaServerUrl(serverUrl)}/v1`;
}

export class LlamaClient {
	readonly serverUrl: string;
	private readonly apiKey: string | undefined;

	constructor(serverUrl: string, apiKey?: string) {
		this.serverUrl = normalizeLlamaServerUrl(serverUrl);
		this.apiKey = apiKey;
	}

	private async request(path: string, init: RequestInit = {}): Promise<unknown> {
		const headers = new Headers(init.headers);
		if (init.body !== undefined) headers.set("Content-Type", "application/json");
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		const timeout = AbortSignal.timeout(15_000);
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		const response = await fetch(`${this.serverUrl}${path}`, { ...init, headers, signal });
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (!response.ok) throw new Error(errorMessage(payload, `llama.cpp returned HTTP ${response.status}`));
		return payload;
	}

	async list(options: { reload?: boolean; signal?: AbortSignal } = {}): Promise<LlamaModelInfo[]> {
		const payload = await this.request(`/models${options.reload ? "?reload=1" : ""}`, { signal: options.signal });
		if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
			throw new Error("llama.cpp returned an invalid model catalog");
		}
		const data = (payload as { data: unknown[] }).data;
		if (!data.every(isModelInfo)) throw new Error("Server is not running in llama.cpp router mode");
		return data;
	}

	async load(model: string, signal?: AbortSignal): Promise<void> {
		await this.request("/models/load", { method: "POST", body: JSON.stringify({ model }), signal });
	}

	async unload(model: string, signal?: AbortSignal): Promise<void> {
		await this.request("/models/unload", { method: "POST", body: JSON.stringify({ model }), signal });
	}

	async unloadAndWait(model: string, signal?: AbortSignal): Promise<void> {
		await this.unload(model, signal);
		while (true) {
			const entry = (await this.list({ signal })).find((candidate) => candidate.id === model);
			if (!entry || entry.status.value === "unloaded") return;
			await sleep(100, signal);
		}
	}

	async download(model: string, signal?: AbortSignal): Promise<void> {
		await this.request("/models", { method: "POST", body: JSON.stringify({ model }), signal });
	}

	async watch(onEvent: (event: LlamaModelEvent) => void, signal?: AbortSignal): Promise<void> {
		const headers = new Headers();
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		const response = await fetch(`${this.serverUrl}/models/sse`, { headers, signal });
		if (!response.ok || !response.body) throw new Error(`llama.cpp SSE returned HTTP ${response.status}`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (data) {
					try {
						const event = JSON.parse(data) as LlamaModelEvent;
						if (event && typeof event.model === "string" && typeof event.event === "string") onEvent(event);
					} catch {
						// Ignore malformed events; catalog polling remains authoritative.
					}
				}
				boundary = buffer.indexOf("\n\n");
			}
		}
	}

	async loadAndWait(
		model: string,
		onProgress: (progress: LlamaProgress) => void,
		signal?: AbortSignal,
	): Promise<LlamaModelInfo> {
		const watcher = new AbortController();
		const unlink = linkSignal(signal, watcher);
		let eventLoaded = false;
		let eventError: string | undefined;
		void this.watch((event) => {
			if (event.model !== model) return;
			if (event.event !== "model_status" && event.event !== "status_change") return;
			const data = event.data as { status?: unknown } | undefined;
			if (data?.status === "loaded") eventLoaded = true;
			if (data?.status === "unloaded") eventError = "Model failed to load";
			const progress = parseLoadProgress(event.data);
			if (progress) onProgress(progress);
		}, watcher.signal).catch(() => {});
		try {
			await this.load(model, signal);
			onProgress({ message: "Loading model" });
			while (true) {
				if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
				const entry = (await this.list({ signal })).find((candidate) => candidate.id === model);
				if (entry?.status.value === "loaded") return entry;
				if (eventLoaded && !entry) return { id: model, status: { value: "loaded" } };
				if (entry?.status.failed || eventError) {
					throw new Error(
						entry?.status.exit_code === undefined
							? (eventError ?? "Model failed to load")
							: `Model exited with code ${entry.status.exit_code}`,
					);
				}
				await sleep(250, signal);
			}
		} finally {
			unlink();
			watcher.abort();
		}
	}

	async downloadAndWait(
		model: string,
		onProgress: (progress: LlamaProgress) => void,
		signal?: AbortSignal,
	): Promise<LlamaModelInfo[]> {
		const watcher = new AbortController();
		const unlink = linkSignal(signal, watcher);
		let finished = false;
		let failure: string | undefined;
		let sawDownloading = false;
		let polls = 0;
		void this.watch((event) => {
			if (event.model !== model) return;
			if (event.event === "download_finished") finished = true;
			if (event.event === "download_failed") failure = errorMessage(event.data, "Download failed");
			if (event.event === "download_progress") {
				sawDownloading = true;
				const progress = parseDownloadProgress(event.data);
				if (progress) onProgress(progress);
			}
		}, watcher.signal).catch(() => {});
		try {
			await this.download(model, signal);
			onProgress({ message: "Downloading model" });
			while (true) {
				if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
				if (failure) throw new Error(failure);
				const models = await this.list({ signal });
				polls++;
				const entry = models.find((candidate) => candidate.id === model);
				if (entry?.status.value === "downloading") {
					sawDownloading = true;
					const progress = parseDownloadProgress(entry.status.progress);
					if (progress) onProgress(progress);
				} else if (finished || (entry && (sawDownloading || polls >= 2))) {
					return this.list({ reload: true, signal });
				}
				await sleep(500, signal);
			}
		} finally {
			unlink();
			watcher.abort();
		}
	}
}
