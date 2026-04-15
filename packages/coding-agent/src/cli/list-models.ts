/**
 * List available models with optional fuzzy search
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { fuzzyFilter } from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { ModelRegistry } from "../core/model-registry.js";

/**
 * Format a number as human-readable (e.g., 200000 -> "200K", 1000000 -> "1M")
 */
function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

/**
 * List available models, optionally filtered by search pattern
 */
export async function listModels(modelRegistry: ModelRegistry, searchPattern?: string): Promise<void> {
	const loadError = modelRegistry.getError();
	if (loadError) {
		console.error(chalk.yellow(`Warning: errors loading models.json:\n${loadError}`));
	}

	const models = modelRegistry.getAvailable();

	if (models.length === 0) {
		console.log("No models available. Set API keys in environment variables.");
		return;
	}

	// Apply fuzzy filter if search pattern provided
	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	if (filteredModels.length === 0) {
		console.log(`No models matching "${searchPattern}"`);
		return;
	}

	// Sort by provider, then by model id
	filteredModels.sort((a, b) => {
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});

	// Calculate column widths
	const rows = filteredModels.map((m) => ({
		provider: m.provider,
		model: m.id,
		context: formatTokenCount(m.contextWindow),
		maxOut: formatTokenCount(m.maxTokens),
		thinking: m.reasoning ? "yes" : "no",
		images: m.input.includes("image") ? "yes" : "no",
	}));

	const headers = {
		provider: "provider",
		model: "model",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	};

	const widths = {
		provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
		model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
		images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
	};

	// Print header
	const headerLine = [
		headers.provider.padEnd(widths.provider),
		headers.model.padEnd(widths.model),
		headers.context.padEnd(widths.context),
		headers.maxOut.padEnd(widths.maxOut),
		headers.thinking.padEnd(widths.thinking),
		headers.images.padEnd(widths.images),
	].join("  ");
	console.log(headerLine);

	// Print rows
	for (const row of rows) {
		const line = [
			row.provider.padEnd(widths.provider),
			row.model.padEnd(widths.model),
			row.context.padEnd(widths.context),
			row.maxOut.padEnd(widths.maxOut),
			row.thinking.padEnd(widths.thinking),
			row.images.padEnd(widths.images),
		].join("  ");
		console.log(line);
	}
}
