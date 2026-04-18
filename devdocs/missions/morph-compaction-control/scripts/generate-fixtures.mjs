import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const missionDir = dirname(__dirname);
const fixturesDir = join(missionDir, 'fixtures');

const visibleHistorySourceSession = join(
	homedir(),
	'.mu',
	'agent',
	'sessions',
	'--Users-kennyfrc-Documents-code-work-pi-mono-kenn-dev--',
	'2026-03-19T11-59-28-534Z_5ac506f0-3754-4bf0-a0d5-3ff73c3d4df3.jsonl',
);

function loadJsonl(path) {
	return readFileSync(path, 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function collectVisibleMessages(entries, limit) {
	const messages = [];
	for (const entry of entries) {
		if ((entry.type === 'message' || entry.type === 'custom_message') && entry.message && typeof entry.message === 'object') {
			messages.push(entry.message);
		}
		if (messages.length >= limit) {
			break;
		}
	}
	return messages;
}

function createVisibleHistoryFixture() {
	const entries = loadJsonl(visibleHistorySourceSession);
	const messages = collectVisibleMessages(entries, 6);
	if (messages.length !== 6) {
		throw new Error(`Expected 6 visible messages, got ${messages.length}`);
	}

	return {
		id: 'visible-history-compaction',
		kind: 'visible-history',
		sourceSession: visibleHistorySourceSession,
		selection: 'first 6 visible messages from the 2026-03-19 11:59 workspace session',
		goal: 'Continue debugging resume semantics of /mission-submit mission mode without losing mission source-of-truth context.',
		query: 'Continue debugging resume semantics of /mission-submit mission mode',
		expectedVerbatimLine: 'There is a bug in resume semantics of the missions where if we abort the mission, then send a new message, what happens is that it makes a new missino iteration.',
		messages,
	};
}

function createNativeReplayRequiredFixture() {
	return {
		id: 'native-replay-required',
		kind: 'native-replay-required',
		source: 'synthetic fixture derived from current native compact replay semantics',
		goal: 'Continue the same-provider session without losing opaque native compact replay state.',
		query: 'Continue the same-provider session after native compact replay',
		expectedStrategyGuard: 'native-replay-required',
		messages: [
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: 'We already compacted this OpenAI/Codex thread once. Keep resume semantics exact and continue the existing debugging task.',
					},
				],
				timestamp: 1,
			},
			{
				role: 'assistant',
				content: [
					{
						type: 'text',
						text: 'I preserved the native compact replay item and inspected the remaining session history.',
					},
				],
				api: 'openai-codex-responses',
				provider: 'openai-codex',
				model: 'gpt-5.4',
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: 'stop',
				timestamp: 2,
			},
			{
				role: 'user',
				content: [],
				__muCompactResponseItem: {
					type: 'compaction',
					encrypted_content: 'opaque-native-replay-fixture',
				},
				timestamp: 3,
			},
			{
				role: 'assistant',
				content: [
					{
						type: 'text',
						text: 'The next compaction strategy must keep native replay semantics instead of flattening this checkpoint into plain text.',
					},
				],
				api: 'openai-codex-responses',
				provider: 'openai-codex',
				model: 'gpt-5.4',
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: 'stop',
				timestamp: 4,
			},
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: 'Resume the same task and preserve whatever hidden replay state the provider needs.',
					},
				],
				timestamp: 5,
			},
		],
	};
}

mkdirSync(fixturesDir, { recursive: true });

const fixtureFiles = [
	['visible-history-compaction.json', createVisibleHistoryFixture()],
	['native-replay-required.json', createNativeReplayRequiredFixture()],
];

for (const [name, value] of fixtureFiles) {
	writeFileSync(join(fixturesDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

console.log(
	JSON.stringify(
		{
			fixturesDir,
			files: fixtureFiles.map(([name, value]) => ({
				name,
				messageCount: Array.isArray(value.messages) ? value.messages.length : 0,
			})),
		},
		null,
		2,
	),
);
