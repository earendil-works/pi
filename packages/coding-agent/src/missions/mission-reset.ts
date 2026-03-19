import { appendFileSync } from "node:fs";
import { parseMissionDefinition } from "./parse-mission.js";

export interface MissionResumeResetControlEvent {
	type: "control";
	kind: "resume-reset";
	timestamp: number;
	note: string;
}

function validateMissionHistoryForReset(experimentsText: string): void {
	const lines = experimentsText.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = lines[index]?.trim() ?? "";
		if (!trimmed) {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Mission EXPERIMENTS.jsonl contains malformed JSON on line ${index + 1}: ${message}`);
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`Mission EXPERIMENTS.jsonl line ${index + 1} must be a JSON object`);
		}
	}
}

export function appendMissionResumeResetEvent(
	missionDir: string,
	timestamp: number = Date.now(),
): {
	resolvedMissionDir: string;
	experimentsPath: string;
	event: MissionResumeResetControlEvent;
} {
	const mission = parseMissionDefinition(missionDir);
	if (mission.mode !== "optimize") {
		throw new Error(`Mission reset only works for optimize missions: ${mission.dir}`);
	}
	if (!mission.experimentsPath || mission.experimentsText === undefined) {
		throw new Error(`Mission reset requires EXPERIMENTS.jsonl: ${mission.dir}`);
	}

	validateMissionHistoryForReset(mission.experimentsText);

	const event: MissionResumeResetControlEvent = {
		type: "control",
		kind: "resume-reset",
		timestamp,
		note: "Manual resume reset",
	};
	appendFileSync(mission.experimentsPath, `${JSON.stringify(event)}\n`);

	return {
		resolvedMissionDir: mission.dir,
		experimentsPath: mission.experimentsPath,
		event,
	};
}
