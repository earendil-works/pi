import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const missionDir = dirname(__dirname);
const fixturesDir = join(missionDir, 'fixtures');
const visibleFixturePath = join(fixturesDir, 'visible-history-compaction.json');

JSON.parse(readFileSync(visibleFixturePath, 'utf8'));

const tmpProbeDir = join(tmpdir(), 'morph-compaction-control');
mkdirSync(tmpProbeDir, { recursive: true });

const sharedSource = `
import { readFileSync } from 'node:fs';

const fixturePath = ${JSON.stringify(visibleFixturePath)};
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const morphApiKey = process.env.MORPH_API_KEY;
if (!morphApiKey) throw new Error('MORPH_API_KEY is not set');

function getTextFromContent(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      parts.push(\`<thinking>\\n\${block.thinking}\\n</thinking>\`);
    }
    if (block.type === 'toolCall') {
      const name = typeof block.name === 'string' ? block.name : 'unknown_tool';
      parts.push(\`<tool_call name="\${name}">\${JSON.stringify(block.arguments ?? {})}</tool_call>\`);
    }
  }
  return parts;
}

function toMorphMessages(messages) {
  const result = [];
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') {
      const content = getTextFromContent(message.content).join('\\n\\n').trim();
      if (content) result.push({ role: message.role, content });
      continue;
    }

    if (message.role === 'toolResult') {
      const toolName = typeof message.toolName === 'string' ? message.toolName : 'tool';
      const text = getTextFromContent(message.content).join('\\n\\n').trim() || '(no text content)';
      result.push({ role: 'assistant', content: \`<tool_result name="\${toolName}">\\n\${text}\\n</tool_result>\` });
    }
  }
  return result;
}

function toTranscript(messages) {
  return messages.map((message) => {
    if (message.role === 'toolResult') {
      const toolName = typeof message.toolName === 'string' ? message.toolName : 'tool';
      const text = getTextFromContent(message.content).join('\\n\\n').trim() || '(no text content)';
      return \`toolResult(\${toolName}):\\n\${text}\`;
    }
    const text = getTextFromContent(message.content).join('\\n\\n').trim();
    return \`\${message.role}:\\n\${text}\`;
  }).filter(Boolean).join('\\n\\n');
}

async function postJson(path, body) {
  const response = await fetch(\`https://api.morphllm.com\${path}\`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: \`Bearer \${morphApiKey}\`,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(\`\${path} failed: \${response.status} \${JSON.stringify(json)}\`);
  return json;
}

const transcript = toTranscript(fixture.messages);
const morphMessages = toMorphMessages(fixture.messages);
if (!transcript.includes(fixture.expectedVerbatimLine)) {
  throw new Error('Fixture transcript is missing the expected verbatim line');
}
`;

const probeScript = `${sharedSource}
const compactMessages = await postJson('/v1/compact', {
  messages: morphMessages,
  query: fixture.query,
  compression_ratio: 0.5,
  preserve_recent: 0,
});

const compactTranscript = await postJson('/v1/compact', {
  input: transcript,
  query: fixture.query,
  compression_ratio: 0.5,
  preserve_recent: 0,
});

const responsesCompat = await postJson('/v1/responses', {
  model: 'morph-compactor',
  input: transcript,
  query: fixture.query,
});

console.log(JSON.stringify({
  fixtureId: fixture.id,
  compactMessages: {
    usage: compactMessages.usage ?? null,
    outputChars: typeof compactMessages.output === 'string' ? compactMessages.output.length : null,
  },
  compactTranscript: {
    usage: compactTranscript.usage ?? null,
    outputChars: typeof compactTranscript.output === 'string' ? compactTranscript.output.length : null,
  },
  responsesCompat: {
    usage: responsesCompat.usage ?? null,
    outputTextSample: responsesCompat?.output?.[0]?.content?.[0]?.text?.slice(0, 240) ?? null,
  },
}, null, 2));
`;

const verbatimScript = `${sharedSource}
const compactTranscript = await postJson('/v1/compact', {
  input: transcript,
  query: fixture.query,
  compression_ratio: 0.5,
  preserve_recent: 0,
});

const output = String(compactTranscript.output ?? '');
const inputLines = new Set(transcript.split('\\n'));
const badLines = output
  .split('\\n')
  .filter((line) => line.length > 0)
  .filter((line) => !/^\\(filtered \\d+ lines\\)$/.test(line))
  .filter((line) => !inputLines.has(line));

console.log(JSON.stringify({
  fixtureId: fixture.id,
  expectedVerbatimLinePresent: output.includes(fixture.expectedVerbatimLine),
  nonVerbatimLineCount: badLines.length,
  sampleBadLines: badLines.slice(0, 10),
  usage: compactTranscript.usage ?? null,
}, null, 2));
`;

const queryCompareScript = `${sharedSource}
async function run(query) {
  const compactTranscript = await postJson('/v1/compact', {
    input: transcript,
    query,
    compression_ratio: 0.5,
    preserve_recent: 0,
  });

  return {
    query,
    usage: compactTranscript.usage ?? null,
    outputChars: typeof compactTranscript.output === 'string' ? compactTranscript.output.length : null,
  };
}

const noisyQuery = String(fixture.messages[0]?.content?.[0]?.text ?? '').slice(0, 500) || fixture.query;
console.log(JSON.stringify({
  concise: await run(fixture.query),
  noisy: await run(noisyQuery),
}, null, 2));
`;

const files = [
	['morph-compaction-probe.mjs', probeScript],
	['morph-verbatim-check.mjs', verbatimScript],
	['morph-query-compare.mjs', queryCompareScript],
];

for (const [name, source] of files) {
	writeFileSync(join(tmpProbeDir, name), source, 'utf8');
}

console.log(
	JSON.stringify(
		{
			tmpProbeDir,
			files: files.map(([name]) => join(tmpProbeDir, name)),
		},
		null,
		2,
	),
);
