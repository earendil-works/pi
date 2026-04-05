import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function writeDeterministicExecWrapper(wrapperPath: string, repoRoot: string): void {
	writeFileSync(
		wrapperPath,
		String.raw`
import { main } from '${repoRoot}/packages/coding-agent/src/main.ts';
import { ProviderTransport } from '@kennyfrc/mu-agent-core';
import { agentLoop, getModel } from '@kennyfrc/mu-ai';
import { AssistantMessageEventStream } from '${repoRoot}/packages/ai/src/utils/event-stream.ts';

function makeAssistantBase(model) {
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    usage: { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{input:0, output:0, cacheRead:0, cacheWrite:0, total:0}},
    timestamp: Date.now(),
  };
}

class DeterministicExecTransport {
  constructor() { this.callCount = 0; this.model = getModel('openai', 'gpt-4o-mini'); }
  async *run(messages, userMessage, cfg, signal) {
    const context = { systemPrompt: cfg.systemPrompt, messages, tools: cfg.tools };
    const loopConfig = { model: cfg.model, reasoning: cfg.reasoning, interrupt: cfg.interrupt, toolResultTransformer: cfg.toolResultTransformer };
    for await (const event of agentLoop(userMessage, context, loopConfig, signal, this.streamFn.bind(this))) {
      yield event;
    }
  }
  streamFn(_model, context) {
    this.callCount += 1;
    const stream = new AssistantMessageEventStream();
    const model = this.model;
    const scenario = process.env.MU_MEMORY_TEST_SCENARIO;
    const lastToolResult = [...context.messages].reverse().find((message) => message.role === 'toolResult');
    let assistantMessage;
    if (this.callCount === 1 && scenario === 'store') {
      assistantMessage = {
        ...makeAssistantBase(model),
        content: [{ type: 'toolCall', id: 'mem-store', name: 'memory_store', arguments: { kind: 'decision', summary: 'The launch code is ORANGE-KITE-441', sourceRefs: ['explicit:user-request'] } }],
        stopReason: 'toolUse',
      };
    } else if (this.callCount === 1 && scenario === 'retrieve') {
      assistantMessage = {
        ...makeAssistantBase(model),
        content: [{ type: 'toolCall', id: 'mem-search', name: 'memory_search', arguments: { query: 'launch code', limit: 5 } }],
        stopReason: 'toolUse',
      };
    } else {
      const toolText = Array.isArray(lastToolResult?.content)
        ? lastToolResult.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        : '';
      assistantMessage = {
        ...makeAssistantBase(model),
        content: [{ type: 'text', text: toolText }],
        stopReason: 'stop',
      };
    }
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: assistantMessage });
      stream.push({ type: 'done', reason: assistantMessage.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: assistantMessage });
    });
    return stream;
  }
}

ProviderTransport.prototype.run = function(messages, userMessage, cfg, signal) {
  const transport = new DeterministicExecTransport();
  return transport.run(messages, userMessage, cfg, signal);
};

async function run() {
  if (process.env.MU_MEMORY_TEST_WORKSPACE) {
    process.chdir(process.env.MU_MEMORY_TEST_WORKSPACE);
  }
  await main(process.argv.slice(2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
		"utf8",
	);
}

describe("artifact memory fresh-session retrieval (red)", () => {
	let repoRoot: string;
	let workspaceDir: string;
	let configDir: string;
	let wrapperPath: string;

	beforeEach(() => {
		repoRoot = resolve(process.cwd(), "..", "..");
		workspaceDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-fresh-session-ws-"));
		configDir = mkdtempSync(join(tmpdir(), "mu-artifact-memory-fresh-session-config-"));
		wrapperPath = join(tmpdir(), `mu-artifact-memory-fresh-session-wrapper-${Date.now()}.ts`);
		mkdirSync(join(workspaceDir, ".git"), { recursive: true });
		writeFileSync(join(workspaceDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
		writeDeterministicExecWrapper(wrapperPath, repoRoot);
	});

	afterEach(() => {
		rmSync(workspaceDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
		rmSync(wrapperPath, { force: true });
	});

	it("uses the memory tool boundary to store and then retrieve a fact across fresh mu exec --json sessions", () => {
		execFileSync(
			"npx",
			[
				"tsx",
				wrapperPath,
				"exec",
				"--json",
				"Please store the launch code in memory.",
				"--provider",
				"openai",
				"--model",
				"gpt-4o-mini",
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: {
					...process.env,
					MU_CODING_AGENT_DIR: configDir,
					MU_MEMORY_TEST_WORKSPACE: workspaceDir,
					OPENAI_API_KEY: "test-openai-key",
					MU_MEMORY_TEST_SCENARIO: "store",
				},
			},
		);

		let retrieveOutput = "";
		let sawValue = false;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			retrieveOutput = execFileSync(
				"npx",
				[
					"tsx",
					wrapperPath,
					"exec",
					"--json",
					"What is the launch code?",
					"--provider",
					"openai",
					"--model",
					"gpt-4o-mini",
				],
				{
					cwd: repoRoot,
					encoding: "utf8",
					env: {
						...process.env,
						MU_CODING_AGENT_DIR: configDir,
						MU_MEMORY_TEST_WORKSPACE: workspaceDir,
						OPENAI_API_KEY: "test-openai-key",
						MU_MEMORY_TEST_SCENARIO: "retrieve",
					},
				},
			);
			if (retrieveOutput.includes("ORANGE-KITE-441")) {
				sawValue = true;
				break;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}

		expect(sawValue).toBe(true);
		expect(retrieveOutput).toContain("ORANGE-KITE-441");
		expect(retrieveOutput).toContain("memory_search");
	});
});
