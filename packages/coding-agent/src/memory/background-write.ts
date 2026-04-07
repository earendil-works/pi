import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { ARTIFACT_MEMORY_GLOBAL_SCOPE, type ArtifactMemoryEntryInput } from "./store.js";

export interface ArtifactMemoryBackgroundWriteRequest {
	entries: ArtifactMemoryEntryInput[];
	workspaceRef: string;
	baseDir?: string;
	onWarning?: (message: string) => void;
}

export interface ArtifactMemoryBackgroundWriteReceipt {
	taskId: string;
	queued: true;
	workspaceRef: string;
}

const BACKGROUND_WRITER_SCRIPT = String.raw`
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function normalizeWorkspaceRef(workspaceRef) {
  if (workspaceRef === ${JSON.stringify(ARTIFACT_MEMORY_GLOBAL_SCOPE)}) {
    return workspaceRef;
  }
  const resolved = path.resolve(workspaceRef);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function getArtifactMemoryRoot(baseDir) {
  return baseDir ? path.resolve(baseDir, '.mu', 'wiki') : path.resolve(path.join(os.homedir(), '.mu', 'wiki'));
}

const payload = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
const root = getArtifactMemoryRoot(payload.baseDir);
const workspaceRef = normalizeWorkspaceRef(payload.workspaceRef);
const ledgerPath = path.join(root, 'entries.jsonl');
fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

for (const entry of payload.entries) {
  const stored = {
    id: 'mem-' + crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event: entry.event ?? 'create',
    kind: entry.kind,
    summary: entry.summary,
    workspaceRef,
    artifacts: entry.artifacts,
    sourceRefs: entry.sourceRefs,
    targetId: entry.targetId,
  };
  fs.appendFileSync(ledgerPath, JSON.stringify(stored) + '\n', 'utf8');
}
`;

export function enqueueArtifactMemoryWrite(
	request: ArtifactMemoryBackgroundWriteRequest,
): ArtifactMemoryBackgroundWriteReceipt {
	const taskId = `memq-${randomUUID()}`;
	const payload = Buffer.from(
		JSON.stringify({
			entries: request.entries,
			workspaceRef: request.workspaceRef,
			baseDir: request.baseDir,
		}),
		"utf8",
	).toString("base64url");

	const child = spawn(process.execPath, ["-e", BACKGROUND_WRITER_SCRIPT, payload], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});

	child.on("error", (error) => {
		request.onWarning?.(`Artifact memory background write failed to start: ${error.message}`);
	});
	child.unref();

	return {
		taskId,
		queued: true,
		workspaceRef: request.workspaceRef,
	};
}
