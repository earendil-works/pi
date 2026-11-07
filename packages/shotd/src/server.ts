#!/usr/bin/env node
// shotd MCP server (stdio JSON-RPC). Tools: shot, zoom, dom_metrics, baseline_save, baseline_diff, close_context.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserManager, type CaptureOptions } from "./browser.ts";
import { cropForZoom, diffImages, encodeArchive, isValidWebP, resizeForModel } from "./image.ts";
import { ShotStore } from "./store.ts";

const root = process.env.SHOTD_DIR ?? join(process.cwd(), ".shotd");

const store = new ShotStore(root);
const browser = new BrowserManager();

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string | null;
	method: string;
	params?: Record<string, unknown>;
}

function send(id: unknown, result: unknown): void {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function sendError(id: unknown, message: string, code = -32603): void {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const TOOLS = [
	{
		name: "shot",
		description: "Capture page as 4K WebP (1920x1080 @2x → 3840x2160). Archive on disk; returns resized model view.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string" },
				selector: { type: "string" },
				viewport: { type: "object" },
				clip: { type: "object" },
				format: { type: "string", default: "webp" },
				quality: { type: "number" },
				lossless: { type: "boolean" },
				agentId: { type: "string" },
				maxLongEdge: { type: "number" },
			},
			required: ["url"],
		},
	},
	{
		name: "zoom",
		description: "Native-resolution crop of stored shot.",
		inputSchema: {
			type: "object",
			properties: {
				shotId: { type: "string" },
				region: { type: "object" },
				scale: { type: "number" },
				maxLongEdge: { type: "number" },
			},
			required: ["shotId", "region"],
		},
	},
	{
		name: "dom_metrics",
		description: "Bounding boxes + computed styles for selectors.",
		inputSchema: {
			type: "object",
			properties: { selectors: { type: "array", items: { type: "string" } }, url: { type: "string" } },
			required: ["selectors", "url"],
		},
	},
	{
		name: "baseline_save",
		description: "Store approved golden image.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string" }, shotId: { type: "string" } },
			required: ["name", "shotId"],
		},
	},
	{
		name: "baseline_diff",
		description: "Pixel diff vs baseline.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				shotId: { type: "string" },
				threshold: { type: "number", default: 0.001 },
			},
			required: ["name", "shotId"],
		},
	},
	{
		name: "close_context",
		description: "Release the agent's browser context.",
		inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
	},
];

async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	if (name === "shot") {
		const captureOpts: CaptureOptions = {
			url: String(args.url ?? "about:blank"),
			selector: args.selector as string | undefined,
			provide: (args.agentId as string) ?? "default",
		};
		const shot = await browser.capture(captureOpts);
		const quality = typeof args.quality === "number" ? args.quality : undefined;
		const lossless = args.lossless === true;
		const maxLongEdge = typeof args.maxLongEdge === "number" ? args.maxLongEdge : 1568;
		const encoded = await encodeArchive(shot.png, { quality, lossless });
		const record = store.save(encoded.buf, { width: encoded.width, height: encoded.height, format: encoded.format });
		const modelView = await resizeForModel(
			encoded.buf,
			encoded.format,
			{ maxLongEdge },
			encoded.width,
			encoded.height,
		);
		const modelPath = record.path + ".model.webp";
		if (encoded.format === "webp" && isValidWebP(modelView)) writeFileSync(modelPath, modelView);
		return {
			shotId: record.id,
			path: record.path,
			width: record.width,
			height: record.height,
			bytes: record.bytes,
			sha256: record.sha256,
			format: record.format,
			modelViewPath: modelPath,
			maxLongEdge,
		};
	}
	if (name === "zoom") {
		const shotId = String(args.shotId ?? "");
		const region = args.region as { x: number; y: number; width: number; height: number };
		if (!shotId || !region) throw new Error("shotd zoom requires shotId and region");
		const maxLongEdge = typeof args.maxLongEdge === "number" ? args.maxLongEdge : 1568;
		// Locate stored shot by id (scan shots dir).
		const { readdirSync, existsSync: exists } = await import("node:fs");
		const { join: pjoin } = await import("node:path");
		const dir = pjoin(store.root, "shots");
		const candidates = readdirSync(dir).filter((f) => f.startsWith(shotId.slice(0, 8)));
		if (candidates.length === 0) throw new Error(`shotd zoom: shot ${shotId} not found`);
		const file = pjoin(dir, candidates[0]!);
		const buf = readFileSync(file);
		const zoomed = await cropForZoom(buf, region, { maxLongEdge });
		const zoomRecord = store.save(zoomed, { width: region.width, height: region.height, format: "webp" });
		return { zoomId: zoomRecord.id, path: zoomRecord.path, bytes: zoomRecord.bytes, region, maxLongEdge };
	}
	if (name === "dom_metrics") {
		const url = String(args.url ?? "about:blank");
		const selectors = (args.selectors as string[] | undefined) ?? [];
		return { metrics: await browser.domMetrics(url, selectors) };
	}
	if (name === "baseline_save") {
		const bname = String(args.name ?? "default");
		const shotId = String(args.shotId ?? "");
		const { readdirSync } = await import("node:fs");
		const { join: pjoin } = await import("node:path");
		const dir = pjoin(store.root, "shots");
		const candidates = readdirSync(dir).filter((f) => f.startsWith(shotId.slice(0, 8)));
		if (candidates.length === 0) throw new Error(`baseline_save: shot ${shotId} not found`);
		const buf = readFileSync(pjoin(dir, candidates[0]!));
		const path = store.saveBaseline(bname, buf);
		return { name: bname, path };
	}
	if (name === "baseline_diff") {
		const bname = String(args.name ?? "default");
		const shotId = String(args.shotId ?? "");
		const threshold = typeof args.threshold === "number" ? args.threshold : 0.001;
		const baseline = store.readBaseline(bname);
		if (!baseline) throw new Error(`baseline_diff: no baseline ${bname}`);
		const { readdirSync } = await import("node:fs");
		const { join: pjoin } = await import("node:path");
		const dir = pjoin(store.root, "shots");
		const candidates = readdirSync(dir).filter((f) => f.startsWith(shotId.slice(0, 8)));
		if (candidates.length === 0) throw new Error(`baseline_diff: shot ${shotId} not found`);
		const current = readFileSync(pjoin(dir, candidates[0]!));
		const diffPath = pjoin(store.root, "shots", `${shotId.slice(0, 8)}-diff.png`);
		const result = await diffImages(baseline, current, { threshold, diffPath });
		return {
			passed: result.passed,
			percentChanged: result.percentChanged,
			changedPixels: result.changedPixels,
			diffPath: result.diffPath ?? diffPath,
			threshold,
		};
	}
	if (name === "close_context") {
		await browser.closeContext(String(args.agentId ?? "default"));
		return { ok: true };
	}
	throw new Error(`shotd: unknown tool ${name}`);
}

async function main(): Promise<void> {
	let buf = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buf += chunk;
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const req = JSON.parse(line) as JsonRpcRequest;
				void handle(req);
			} catch {
				/* ignore malformed */
			}
		}
	});
	async function handle(req: JsonRpcRequest): Promise<void> {
		if (req.method === "initialize") {
			return send(req.id, {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "shotd", version: "1.5.0" },
			});
		}
		if (req.method === "tools/list") return send(req.id, { tools: TOOLS });
		if (req.method === "tools/call") {
			const params = req.params ?? {};
			const toolName = String(params.name ?? "");
			const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
			try {
				const out = await handleTool(toolName, args);
				return send(req.id, {
					content: [{ type: "text", text: JSON.stringify(out) }],
					structuredContent: out as Record<string, unknown>,
				});
			} catch (e) {
				return sendError(req.id, e instanceof Error ? e.message : String(e));
			}
		}
		if (req.method === "notifications/initialized") return undefined;
		return sendError(req.id, `unknown method ${req.method}`, -32601);
	}
	process.on("SIGINT", () => {
		void browser.dispose().then(() => process.exit(0));
	});
	process.on("SIGTERM", () => {
		void browser.dispose().then(() => process.exit(0));
	});
	// Keep alive.
	await new Promise(() => {});
}

void main();
