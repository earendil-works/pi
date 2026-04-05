import { isAbsolute } from "node:path";
import type { ToolResultMessage } from "@kennyfrc/mu-ai";
import type { ArtifactMemoryEntryInput } from "./store.js";
import { normalizeArtifactMemoryWorkspaceRef } from "./store.js";

interface WriteToolDetails {
	path: string;
	created: boolean;
	previousContent: string | null;
	newContentHash: string;
}

interface EditToolDetails {
	path: string;
	diff: string;
	oldText: string;
	newText: string;
	index: number;
	newContentHash: string;
}

interface ApplyPatchParsedOp {
	type: string;
	path: string;
}

interface ApplyPatchToolDetails {
	parsed?: {
		ops?: ApplyPatchParsedOp[];
	};
}

interface BashToolDetails {
	exitCode?: number;
	artifacts?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function getPrimaryText(toolResult: ToolResultMessage<unknown>): string {
	for (const block of toolResult.content) {
		if (block.type === "text" && block.text.trim().length > 0) {
			return block.text.trim();
		}
	}
	return `${toolResult.toolName} completed successfully`;
}

function normalizeArtifactPath(path: string): string {
	return isAbsolute(path) ? normalizeArtifactMemoryWorkspaceRef(path) : path;
}

function deriveWriteArtifact(toolResult: ToolResultMessage<unknown>, workspaceRef: string): ArtifactMemoryEntryInput[] {
	const details = toolResult.details;
	if (!isRecord(details) || typeof details.path !== "string") {
		return [];
	}

	const writeDetails = details as unknown as WriteToolDetails;
	return [
		{
			kind: "artifact",
			summary: getPrimaryText(toolResult),
			workspaceRef,
			artifacts: [normalizeArtifactPath(writeDetails.path)],
			sourceRefs: ["tool:write"],
		},
	];
}

function deriveEditArtifact(toolResult: ToolResultMessage<unknown>, workspaceRef: string): ArtifactMemoryEntryInput[] {
	const details = toolResult.details;
	if (!isRecord(details) || typeof details.path !== "string") {
		return [];
	}

	const editDetails = details as unknown as EditToolDetails;
	return [
		{
			kind: "artifact",
			summary: getPrimaryText(toolResult),
			workspaceRef,
			artifacts: [normalizeArtifactPath(editDetails.path)],
			sourceRefs: ["tool:edit"],
		},
	];
}

function deriveApplyPatchArtifact(
	toolResult: ToolResultMessage<unknown>,
	workspaceRef: string,
): ArtifactMemoryEntryInput[] {
	const details = toolResult.details;
	if (!isRecord(details)) {
		return [];
	}

	const parsed = (details as ApplyPatchToolDetails).parsed;
	const ops = parsed?.ops;
	if (!Array.isArray(ops)) {
		return [];
	}

	const artifacts = ops
		.filter((op): op is ApplyPatchParsedOp => isRecord(op) && typeof op.path === "string")
		.map((op) => normalizeArtifactPath(op.path));
	if (artifacts.length === 0) {
		return [];
	}

	return [
		{
			kind: "artifact",
			summary: getPrimaryText(toolResult),
			workspaceRef,
			artifacts,
			sourceRefs: ["tool:apply_patch"],
		},
	];
}

function deriveBashArtifact(toolResult: ToolResultMessage<unknown>, workspaceRef: string): ArtifactMemoryEntryInput[] {
	const details = toolResult.details;
	if (!isRecord(details)) {
		return [];
	}

	const bashDetails = details as BashToolDetails;
	if (bashDetails.exitCode !== 0 || !isStringArray(bashDetails.artifacts) || bashDetails.artifacts.length === 0) {
		return [];
	}

	return [
		{
			kind: "artifact",
			summary: getPrimaryText(toolResult),
			workspaceRef,
			artifacts: bashDetails.artifacts.map((artifact) => normalizeArtifactPath(artifact)),
			sourceRefs: ["tool:bash"],
		},
	];
}

export function deriveArtifactMemoryEntriesFromToolResult(
	toolResult: ToolResultMessage<unknown>,
	options: { workspaceRef: string },
): ArtifactMemoryEntryInput[] {
	if (toolResult.isError) {
		return [];
	}

	if (toolResult.toolName === "write") {
		return deriveWriteArtifact(toolResult, options.workspaceRef);
	}
	if (toolResult.toolName === "edit") {
		return deriveEditArtifact(toolResult, options.workspaceRef);
	}
	if (toolResult.toolName === "apply_patch") {
		return deriveApplyPatchArtifact(toolResult, options.workspaceRef);
	}
	if (toolResult.toolName === "bash") {
		return deriveBashArtifact(toolResult, options.workspaceRef);
	}

	return [];
}
