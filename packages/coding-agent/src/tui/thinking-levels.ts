import type { ThinkingLevel } from "@kennyfrc/pi-agent-core";
import type { SelectItem } from "@kennyfrc/pi-tui";

type TabThinkingLevel = Exclude<ThinkingLevel, "minimal">;

export function getTabThinkingLevels(supportsXhigh: boolean): TabThinkingLevel[] {
	const levels: TabThinkingLevel[] = ["off", "low", "medium", "high"];
	if (supportsXhigh) {
		levels.push("xhigh");
	}
	return levels;
}

export function getNextThinkingLevel(current: ThinkingLevel, supportsXhigh: boolean): ThinkingLevel {
	const cycle = getTabThinkingLevels(supportsXhigh);
	const currentIndex = cycle.indexOf(current as TabThinkingLevel);
	if (currentIndex === -1) {
		return "low";
	}
	return cycle[(currentIndex + 1) % cycle.length];
}

export function getPreviousThinkingLevel(current: ThinkingLevel, supportsXhigh: boolean): ThinkingLevel {
	if (current === "minimal") {
		return "off";
	}

	const cycle = getTabThinkingLevels(supportsXhigh);
	const currentIndex = cycle.indexOf(current as TabThinkingLevel);
	if (currentIndex === -1) {
		return cycle[cycle.length - 1];
	}
	return cycle[(currentIndex - 1 + cycle.length) % cycle.length];
}

export function getEffectiveThinkingLevel(
	level: ThinkingLevel,
	supportsReasoning: boolean,
	supportsXhigh: boolean,
): ThinkingLevel {
	if (!supportsReasoning) {
		return "off";
	}
	if (level === "xhigh" && !supportsXhigh) {
		return "high";
	}
	return level;
}

export function getThinkingLevelItems(supportsXhigh: boolean): SelectItem[] {
	const items: SelectItem[] = [
		{ value: "off", label: "off", description: "No reasoning" },
		{ value: "minimal", label: "minimal", description: "Very brief reasoning (~1k tokens)" },
		{ value: "low", label: "low", description: "Light reasoning (~2k tokens)" },
		{ value: "medium", label: "medium", description: "Moderate reasoning (~8k tokens)" },
		{ value: "high", label: "high", description: "Deep reasoning (~16k tokens)" },
	];
	if (supportsXhigh) {
		items.push({ value: "xhigh", label: "xhigh", description: "Extreme reasoning (~32k tokens)" });
	}
	return items;
}
