import { i18n } from "@mariozechner/mini-lit";
import type { Usage } from "@tculpepp/pi-ai";

export function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

export function formatModelCost(cost: any): string {
	if (!cost) return i18n("Free");
	const input = cost.input || 0;
	const output = cost.output || 0;
	if (input === 0 && output === 0) return i18n("Free");

	// Format numbers with appropriate precision
	const formatNum = (num: number): string => {
		if (num >= 100) return num.toFixed(0);
		if (num >= 10) return num.toFixed(1).replace(/\.0$/, "");
		if (num >= 1) return num.toFixed(2).replace(/\.?0+$/, "");
		return num.toFixed(3).replace(/\.?0+$/, "");
	};

	return `$${formatNum(input)}/$${formatNum(output)}`;
}

export function formatUsage(usage: Usage) {
	if (!usage) return "";

	const parts = [];
	if (usage.input) parts.push(`↑${formatTokenCount(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokenCount(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
	if (usage.cost?.total) parts.push(formatCost(usage.cost.total));

	return parts.join(" ");
}

export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}
