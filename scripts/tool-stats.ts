#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openBrowser } from "../packages/coding-agent/src/utils/open-browser.ts";

interface TextContent { type: "text"; text: string }
interface ImageContent { type: "image"; data: string; mimeType?: string }
interface ToolCallContent { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> }
type Content = TextContent | ImageContent | ToolCallContent | { type: string; [key: string]: unknown };
interface Message { role?: string; content?: string | Content[]; toolCallId?: string; toolName?: string; details?: unknown }
interface Entry { type?: string; message?: Message }
interface ToolStats { calls: number; results: number; estimatedTokens: number; samples: number[]; errors: number }
interface BashCommandStats { calls: number; estimatedTokens: number; samples: number[] }
interface ToolCallInfo { toolName: string; bashCommand?: string }

const BUCKETS = [0, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, Number.POSITIVE_INFINITY];

function parseArgs(): { sessionsDir: string; output: string } {
	let sessionsDir = join(homedir(), ".pi", "agent", "sessions");
	let output = join(tmpdir(), "pi-tool-stats.html");
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--sessions-dir" && args[i + 1]) sessionsDir = resolve(args[++i]);
		else if ((arg === "--output" || arg === "-o") && args[i + 1]) output = resolve(args[++i]);
		else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: scripts/tool-stats.ts [--sessions-dir <dir>] [--output <file.html>]`);
			process.exit(0);
		}
	}
	return { sessionsDir, output };
}

function jsonlFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...jsonlFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

function getStats<T>(map: Map<string, T>, key: string, create: () => T): T {
	let stats = map.get(key);
	if (!stats) {
		stats = create();
		map.set(key, stats);
	}
	return stats;
}

function createToolStats(): ToolStats {
	return { calls: 0, results: 0, estimatedTokens: 0, samples: [], errors: 0 };
}

function createBashStats(): BashCommandStats {
	return { calls: 0, estimatedTokens: 0, samples: [] };
}

function estimateTokenCount(text: string): number {
	return Math.ceil(text.length / 4);
}

function contentText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => {
		if (block.type === "text" && "text" in block && typeof block.text === "string") return block.text;
		if (block.type === "image" && "data" in block && typeof block.data === "string") return block.data;
		return JSON.stringify(block);
	}).join("\n");
}

function getBashCommand(args: Record<string, unknown> | undefined): string | undefined {
	const command = args?.command;
	return typeof command === "string" ? command : undefined;
}

function commandKey(command: string): string {
	const first = command.split(/\n|&&|\|\||;|\|/)[0]?.trim() ?? command.trim();
	const match = first.match(/^(?:\w+=\S+\s+)*(?:sudo\s+)?([^\s]+)(?:\s+([^\s]+))?/);
	if (!match) return "unknown";
	const bin = match[1] ?? "unknown";
	const sub = match[2] && !match[2].startsWith("-") ? ` ${match[2]}` : "";
	return `${bin}${sub}`;
}

function bucketCounts(samples: number[]): number[] {
	const counts = new Array(BUCKETS.length - 1).fill(0) as number[];
	for (const sample of samples) {
		const index = BUCKETS.findIndex((max, i) => i > 0 && sample <= max) - 1;
		counts[Math.max(0, index)]++;
	}
	return counts;
}

function bucketLabels(): string[] {
	return BUCKETS.slice(0, -1).map((min, i) => {
		const max = BUCKETS[i + 1];
		return Number.isFinite(max) ? `${min}-${max}` : `${min}+`;
	});
}

const { sessionsDir, output } = parseArgs();
if (!existsSync(sessionsDir)) throw new Error(`Sessions directory not found: ${sessionsDir}`);

const tools = new Map<string, ToolStats>();
const bashCommands = new Map<string, BashCommandStats>();
const callsById = new Map<string, ToolCallInfo>();
let parseErrors = 0;
const files = jsonlFiles(sessionsDir);

for (const file of files) {
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry: Entry;
		try { entry = JSON.parse(line) as Entry; } catch { parseErrors++; continue; }
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall" || !("name" in block) || typeof block.name !== "string") continue;
				const stats = getStats(tools, block.name, createToolStats);
				stats.calls++;
				const bashCommand = block.name === "bash" ? getBashCommand(block.arguments) : undefined;
				callsById.set(block.id, { toolName: block.name, bashCommand });
				if (bashCommand) getStats(bashCommands, commandKey(bashCommand), createBashStats).calls++;
			}
		} else if (message.role === "toolResult" && message.toolName) {
			const text = contentText(message.content);
			const tokens = estimateTokenCount(text);
			const stats = getStats(tools, message.toolName, createToolStats);
			stats.results++;
			stats.estimatedTokens += tokens;
			stats.samples.push(tokens);
			if ("isError" in message && message.isError === true) stats.errors++;
			const call = message.toolCallId ? callsById.get(message.toolCallId) : undefined;
			if (call?.bashCommand) {
				const bash = getStats(bashCommands, commandKey(call.bashCommand), createBashStats);
				bash.estimatedTokens += tokens;
				bash.samples.push(tokens);
			}
		}
	}
}

const toolRows = [...tools.entries()].map(([name, s]) => ({ name, ...s, avg: s.results ? s.estimatedTokens / s.results : 0, histogram: bucketCounts(s.samples) })).sort((a, b) => b.estimatedTokens - a.estimatedTokens);
const bashRows = [...bashCommands.entries()].map(([name, s]) => ({ name, ...s, avg: s.samples.length ? s.estimatedTokens / s.samples.length : 0, histogram: bucketCounts(s.samples) })).sort((a, b) => b.estimatedTokens - a.estimatedTokens).slice(0, 50);
const data = { generatedAt: new Date().toISOString(), sessionsDir, files: files.length, parseErrors, bucketLabels: bucketLabels(), tools: toolRows, bashCommands: bashRows };

const html = `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<title>Pi Tool Stats</title>
	<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
	<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 p-6">
	<main class="max-w-7xl mx-auto space-y-6">
		<h1 class="text-3xl font-bold">Pi Tool Stats</h1>
		<p class="text-zinc-400">${data.files} session files from <code>${sessionsDir}</code>. Generated ${data.generatedAt}.</p>
		<section class="grid md:grid-cols-2 gap-6">
			<div class="bg-zinc-900 rounded p-4"><h2 class="font-semibold mb-3">Estimated result tokens by tool</h2><canvas id="tokens"></canvas></div>
			<div class="bg-zinc-900 rounded p-4"><h2 class="font-semibold mb-3">Tool calls</h2><canvas id="calls"></canvas></div>
		</section>
		<section class="grid md:grid-cols-2 gap-6">
			<div class="bg-zinc-900 rounded p-4">
				<div class="flex items-center justify-between gap-4 mb-3">
					<h2 class="font-semibold">Tool result token histogram</h2>
					<select id="toolSelect" class="bg-zinc-800 rounded px-2 py-1 text-sm"></select>
				</div>
				<p id="toolSummary" class="text-sm text-zinc-400 mb-3"></p>
				<canvas id="toolHistogram" height="120"></canvas>
			</div>
			<div class="bg-zinc-900 rounded p-4">
				<div class="flex items-center justify-between gap-4 mb-3">
					<h2 class="font-semibold">Bash result token histogram</h2>
					<select id="bashSelect" class="bg-zinc-800 rounded px-2 py-1 text-sm"></select>
				</div>
				<p id="bashSummary" class="text-sm text-zinc-400 mb-3"></p>
				<canvas id="bashHistogram" height="120"></canvas>
			</div>
		</section>
		<section class="bg-zinc-900 rounded p-4"><h2 class="font-semibold mb-3">Tools</h2><div id="tools"></div></section>
		<section class="bg-zinc-900 rounded p-4">
			<h2 class="font-semibold mb-3">Bash common commands (best effort)</h2>
			<div id="bash" class="mt-4"></div>
		</section>
	</main>
	<script>
		const data=${JSON.stringify(data)};
		function fmt(n){return Math.round(n).toLocaleString()}
		function esc(s){return String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
		function table(rows,el){
			document.getElementById(el).innerHTML='<table class="w-full text-sm"><thead class="text-zinc-400"><tr><th class="text-left p-2">Name</th><th class="text-right p-2">Calls</th><th class="text-right p-2">Results</th><th class="text-right p-2">Est. tokens</th><th class="text-right p-2">Avg/result</th><th class="text-left p-2 w-64">Histogram</th></tr></thead><tbody>'+rows.map((r,i)=>'<tr class="border-t border-zinc-800 hover:bg-zinc-800/50 cursor-pointer" data-row="'+i+'"><td class="p-2 font-mono">'+esc(r.name)+'</td><td class="p-2 text-right">'+fmt(r.calls)+'</td><td class="p-2 text-right">'+fmt(r.results??r.samples.length)+'</td><td class="p-2 text-right">'+fmt(r.estimatedTokens)+'</td><td class="p-2 text-right">'+fmt(r.avg)+'</td><td class="p-2"><canvas id="'+el+'Hist'+i+'" height="34"></canvas></td></tr>').join('')+'</tbody></table>';
			rows.forEach((r,i)=>new Chart(document.getElementById(el+'Hist'+i),{type:'bar',data:{labels:data.bucketLabels,datasets:[{data:r.histogram,label:r.name,backgroundColor:'#60a5fa'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:(items)=>data.bucketLabels[items[0].dataIndex]+' tokens'}}},scales:{x:{display:false},y:{display:false}}}}));
			document.querySelectorAll('#'+el+' tr[data-row]').forEach(row=>row.addEventListener('click',()=>document.getElementById(el==='tools'?'toolSelect':'bashSelect').value=row.dataset.row,document.getElementById(el==='tools'?'toolSelect':'bashSelect').dispatchEvent(new Event('change'))));
		}
		function fillSelect(id,rows){document.getElementById(id).innerHTML=rows.map((r,i)=>'<option value="'+i+'">'+esc(r.name)+'</option>').join('')}
		function summary(r){return fmt(r.calls)+' calls, '+fmt(r.results??r.samples.length)+' results, '+fmt(r.estimatedTokens)+' estimated result tokens, '+fmt(r.avg)+' avg/result'}
		function singleHistogram(canvasId,summaryId,selectId,rows){
			let chart;
			function update(){
				const row=rows[Number(document.getElementById(selectId).value)]??rows[0];
				document.getElementById(summaryId).textContent=row?summary(row):'No data';
				if(chart)chart.destroy();
				chart=new Chart(document.getElementById(canvasId),{type:'bar',data:{labels:data.bucketLabels,datasets:[{label:row?.name??'',data:row?.histogram??[],backgroundColor:'#60a5fa'}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{title:(items)=>data.bucketLabels[items[0].dataIndex]+' tokens',label:(item)=>fmt(item.raw)+' results'}}},scales:{y:{beginAtZero:true,title:{display:true,text:'result count'}},x:{title:{display:true,text:'estimated tokens/result'}}}}});
			}
			document.getElementById(selectId).addEventListener('change',update);
			update();
		}
		table(data.tools,'tools');
		table(data.bashCommands,'bash');
		fillSelect('toolSelect',data.tools);
		fillSelect('bashSelect',data.bashCommands);
		singleHistogram('toolHistogram','toolSummary','toolSelect',data.tools);
		singleHistogram('bashHistogram','bashSummary','bashSelect',data.bashCommands);
		new Chart(document.getElementById('tokens'),{type:'bar',data:{labels:data.tools.map(r=>r.name),datasets:[{label:'estimated tokens',data:data.tools.map(r=>r.estimatedTokens)}]},options:{plugins:{legend:{display:false}}}});
		new Chart(document.getElementById('calls'),{type:'bar',data:{labels:data.tools.map(r=>r.name),datasets:[{label:'calls',data:data.tools.map(r=>r.calls)}]},options:{plugins:{legend:{display:false}}}});
	</script>
</body>
</html>`;

mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, html);
console.log(`Wrote ${output}`);
openBrowser(output);
