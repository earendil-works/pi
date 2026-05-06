import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

export function formatNumber(value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) {
		return "—";
	}
	return new Intl.NumberFormat("en", { notation: value > 999_999 ? "compact" : "standard" }).format(value);
}

export function formatCost(value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) {
		return "$0.00";
	}
	return new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
}

export function compactText(text: string, maxLength = 180): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

export function timeAgo(input: string | number | Date | undefined): string {
	if (!input) return "—";
	const date = input instanceof Date ? input : new Date(input);
	const diffMs = Date.now() - date.getTime();
	if (!Number.isFinite(diffMs)) return "—";
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
