// Session-owned text artifacts and adaptive model-facing output budgets.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import type { ReadonlySessionManager } from "./session-manager.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
import { OutputArtifactsSettingsSchema, type Settings } from "./settings-schema.ts";
import { OutputAccumulator } from "./tools/output-accumulator.ts";
import { sliceHead } from "./tools/truncate.ts";

export interface OutputBudget {
	maxChars: number;
	maxBytes: number;
}

export type OutputArtifact = {
	uri: string;
	path: string;
};

export interface OutputCapture {
	output: OutputAccumulator;
	readonly artifact: OutputArtifact | undefined;
}

type ToolContent = (TextContent | ImageContent)[];

interface ArtifactRegistry {
	stores: WeakMap<ReadonlySessionManager, OutputArtifacts>;
	temporaryDirectory?: string;
}
// Extensions loaded through jiti must share the native session's store and temporary namespace.
const REGISTRY_KEY = Symbol.for("@earendil-works/pi-coding-agent:output-artifacts");
const globals = globalThis as Record<symbol, ArtifactRegistry | undefined>;
const registry: ArtifactRegistry = globals[REGISTRY_KEY] ?? { stores: new WeakMap() };
globals[REGISTRY_KEY] = registry;
const settingsValidator = Compile(OutputArtifactsSettingsSchema);
const MAX_INLINE_BYTES = 64 * 1024;

/** Attach one artifact store to the session facade used by built-ins and extensions. */
export function configureOutputArtifacts(
	owner: ReadonlySessionManager,
	agentDir: string,
	getSettings: () => Settings["outputArtifacts"],
	getContextWindow: () => number | undefined,
): OutputArtifacts {
	const store = new OutputArtifacts(owner, join(agentDir, "artifacts"), getSettings, getContextWindow);
	registry.stores.set(owner, store);
	return store;
}

/** Get the owning session's artifact store; standalone tools have no session-owned storage. */
export function getOutputArtifacts(owner: ReadonlySessionManager): OutputArtifacts | undefined {
	return registry.stores.get(owner);
}

/** Store full captured text outside chat JSONL and expose bounded, retrievable previews. */
export class OutputArtifacts {
	private readonly owner: ReadonlySessionManager;
	private readonly directory: string;
	private readonly getSettings: () => Settings["outputArtifacts"];
	private readonly getContextWindow: () => number | undefined;
	private ownerKey: string | undefined;
	private memoryOwnerKey: string | undefined;
	private namespace = "";
	private preparedDirectory: string | undefined;

	constructor(
		owner: ReadonlySessionManager,
		directory: string,
		getSettings: () => Settings["outputArtifacts"],
		getContextWindow: () => number | undefined,
	) {
		this.owner = owner;
		this.directory = directory;
		this.getSettings = getSettings;
		this.getContextWindow = getContextWindow;
	}

	/** Resolve current settings and model limits once per operation, never per streamed chunk. */
	budget(): OutputBudget {
		const configured = this.getSettings();
		// Settings files are an unvalidated filesystem boundary, unlike typed tool parameters.
		if (configured !== undefined && !settingsValidator.Check(configured))
			throw new Error("Invalid outputArtifacts settings; check maxInlineTokens and contextWindowFraction");
		const defaults = SETTINGS_DEFAULTS.outputArtifacts;
		const maxTokens = configured?.maxInlineTokens ?? defaults.maxInlineTokens;
		const fraction = configured?.contextWindowFraction ?? defaults.contextWindowFraction;
		const window = this.getContextWindow();
		// A small floor leaves room for the artifact reference and a useful continuation page.
		const tokens = Math.max(
			128,
			Math.floor(Math.min(maxTokens, window && window > 0 ? window * fraction : maxTokens)),
		);
		return { maxChars: tokens * 4, maxBytes: MAX_INLINE_BYTES };
	}

	/** Signal storage failures while spilling streamed output at its inline or consumer-buffer budget. */
	capture(maximumBufferedBytes?: number): OutputCapture {
		const budget = this.budget();
		let artifact: OutputArtifact | undefined;
		const output = new OutputAccumulator({
			maxLines: Number.MAX_SAFE_INTEGER,
			maxBytes: Math.min(
				maximumBufferedBytes ?? Number.MAX_SAFE_INTEGER,
				Math.max(4, Math.min(budget.maxChars, budget.maxBytes) - 384),
			),
			createOutputFile: () => {
				const file = this.createStream();
				artifact = file;
				return file;
			},
		});
		return {
			output,
			get artifact() {
				return artifact;
			},
		};
	}
	/** Prepare private storage for a completed result before publishing its reference. */
	async prepare(): Promise<void> {
		const directory = this.namespaceDirectory();
		if (this.preparedDirectory === directory) return;
		await mkdir(directory, { recursive: true, mode: 0o700 });
		this.preparedDirectory = directory;
	}

	/** Open a private output file only when the streaming producer crosses its retention threshold. */
	createStream(): OutputArtifact & { stream: WriteStream } {
		const artifact = this.allocate();
		const directory = dirname(artifact.path);
		if (this.preparedDirectory !== directory) {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			this.preparedDirectory = directory;
		}
		return { ...artifact, stream: createWriteStream(artifact.path, { flags: "wx", mode: 0o600 }) };
	}

	/** Persist all text blocks in order, separated by newlines, without copying image data or joining large strings. */
	async save(content: readonly (TextContent | ImageContent)[]): Promise<OutputArtifact> {
		await this.prepare();
		const { stream, ...artifact } = this.createStream();
		function* chunks() {
			let first = true;
			for (const block of content) {
				if (block.type !== "text") continue;
				if (!first) yield "\n";
				yield block.text;
				first = false;
			}
		}
		await pipeline(Readable.from(chunks(), { objectMode: false }), stream);
		return artifact;
	}

	/** Retain oversized text after tool-result hooks while keeping attachments and small results unchanged. */
	async limit(content: ToolContent): Promise<ToolContent> {
		const budget = this.budget();
		let chars = 0;
		let bytes = 0;
		let textBlocks = 0;
		for (const block of content) {
			if (block.type !== "text") continue;
			const separator = textBlocks++ > 0 ? 1 : 0;
			chars += block.text.length + separator;
			bytes += Buffer.byteLength(block.text) + separator;
		}
		if (chars <= budget.maxChars && bytes <= budget.maxBytes) return content;
		const artifact = await this.save(content);
		// Keep the reference before the preview so later history summarization cannot clip it off the tail.
		const notice = `[Full captured output: ${artifact.uri}. Use read with this path and offset/limit; byteOffset continues long lines.]`;
		let remainingChars = Math.max(0, budget.maxChars - notice.length - 1);
		let remainingBytes = Math.max(0, budget.maxBytes - Buffer.byteLength(notice) - 1);
		let keptTexts = 0;
		const limited: ToolContent = [{ type: "text", text: notice }];
		for (const block of content) {
			if (block.type === "image") {
				limited.push(block);
				continue;
			}
			const separator = keptTexts > 0 ? 1 : 0;
			const text = fitOutputPrefix(
				block.text,
				Math.max(0, remainingChars - separator),
				Math.max(0, remainingBytes - separator),
			);
			if (text) {
				limited.push({ type: "text", text });
				keptTexts++;
				remainingChars -= text.length + separator;
				remainingBytes -= Buffer.byteLength(text) + separator;
			}
		}
		return limited;
	}

	/** Resolve only well-formed references within persistent or process-owned temporary storage. */
	resolve(uri: string): string {
		// Artifact URIs are model-authored wire input; never interpret their components as arbitrary paths.
		const match =
			/^artifact:\/\/(?:(temporary)\/)?([a-f0-9]{64})\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
				uri,
			);
		if (!match) throw new Error("Invalid artifact URI; use the exact artifact:// reference returned by the tool");
		const directory = match[1] ? registry.temporaryDirectory : this.directory;
		if (!directory) throw new Error("Temporary artifact is unavailable outside its originating process");
		return join(directory, match[2], `${match[3]}.txt`);
	}

	private allocate(): OutputArtifact {
		const directory = this.namespaceDirectory();
		const id = randomUUID();
		const scope = this.owner.getSessionFile() ? "" : "temporary/";
		return { uri: `artifact://${scope}${this.namespace}/${id}`, path: join(directory, `${id}.txt`) };
	}

	private namespaceDirectory(): string {
		let key = this.owner.getSessionFile();
		if (!key) {
			this.memoryOwnerKey ??= randomUUID();
			key = `memory:${this.memoryOwnerKey}:${this.owner.getSessionId()}`;
		}
		if (key !== this.ownerKey) {
			this.ownerKey = key;
			this.namespace = createHash("sha256").update(key).digest("hex");
		}
		return join(this.baseDirectory(), this.namespace);
	}

	private baseDirectory(): string {
		if (this.owner.getSessionFile()) return this.directory;
		if (!registry.temporaryDirectory) {
			const directory = mkdtempSync(join(tmpdir(), "pi-artifacts-"));
			registry.temporaryDirectory = directory;
			process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
		}
		return registry.temporaryDirectory;
	}
}

/** Take a bounded UTF-8-safe prefix; only the bounded candidate is encoded. */
export function fitOutputPrefix(text: string, maxChars: number, maxBytes: number): string {
	if (maxChars <= 0 || maxBytes <= 0) return "";
	const candidate = sliceHead(text, Math.min(maxChars, maxBytes));
	const bytes = Buffer.from(candidate);
	return bytes.length <= maxBytes ? candidate : bytes.subarray(0, utf8PrefixEnd(bytes, maxBytes)).toString("utf8");
}

/** End a byte page before any incomplete trailing UTF-8 sequence. */
export function utf8PrefixEnd(bytes: Uint8Array, maximum: number): number {
	let end = Math.min(bytes.length, maximum);
	if (end === bytes.length) return end;
	let start = end;
	while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
	if (start === end) return end;
	const lead = bytes[start];
	const length =
		lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
	if (start + length > end) end = start;
	return end;
}
