# Pi evals

Pi evals are behavioral, model-backed checks for Pi workflows. They adapt a real `AgentSession` to `vitest-evals`, run
it in isolated temporary project and agent directories, and attach native Pi session artifacts.
Use them to measure end-to-end behavior and compare prompts, tools, skills, models, or other harness configurations.

## Running evals

Run from the repository root with a default provider and model:

```bash
npm run eval -- --provider openai --model gpt-5.6-sol
```

The equivalent environment variables are:

```bash
PI_PROVIDER=openai PI_MODEL=gpt-5.6-sol npm run eval
```

CLI values take precedence and become defaults for harnesses that do not select a model explicitly. Provider and model must be supplied together. The runner also allows no default when every executed harness configures its own model.
Authentication comes from Pi's normal `ModelRuntime`, including Pi subscription credentials and provider API-key
environment variables.

Additional arguments are forwarded to Vitest:

```bash
npm run eval -- src/extensions.eval.ts
npm run eval -- -t "creates, reloads, and uses"
```

Each invocation prints an ignored `.eval/` artifact directory. `runs.jsonl` indexes completed harness runs and their
native Pi session JSONL attachments under `sessions/`. These files may contain prompts, responses, source code, and tool
output.

## Writing evals

Follow [`vitest-evals`](https://github.com/getsentry/vitest-evals) for general suite, judge, assertion, and normalized
trace guidance. Pi-specific evals use `createPiCodingAgentHarness(...)` from `src/pi-harness.ts`, with one harness bound
to each `describeEval(...)` suite:

```ts
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createPiCodingAgentHarness } from "./pi-harness.ts";

const harness = createPiCodingAgentHarness({ noTools: "all" });

describeEval("Pi smoke", { harness }, (it) => {
	it("answers a factual question", async ({ run }) => {
		const result = await run("What is the capital of France? Reply with only the city name.");
		expect(result.output).toBe("Paris");
	});
});
```

### Configuring the Pi harness

`createPiCodingAgentHarness(...)` accepts:

- `name`: stable harness identity used by reports and comparisons.
- `model`: optional `{ provider, id }` selection. It overrides the runner's default model.
- `noTools`: Pi's tool-disable configuration.
- `transformSystemPrompt`: transforms the complete default prompt before the eval starts.
- `output`: transforms the final response and `AgentSession` into a JSON-safe domain result.

An explicitly selected model makes model-comparison harnesses independent of the runner default:

```ts
const harness = createPiCodingAgentHarness({
	name: "claude-opus-4-6",
	model: { provider: "anthropic", id: "claude-opus-4-6" },
});
```

A run accepts either one prompt or a sequence of prompt and reload steps. Reload steps are useful when the preceding
prompt creates or changes Pi resources:

```ts
const result = await run([
	{ type: "prompt", content: "Create a Pi extension." },
	{ type: "reload" },
	{ type: "prompt", content: "Use the extension." },
]);
```

### Transforming harness output

Use `output` to expose scenario-specific, JSON-safe behavior without adding that behavior to the generic Pi adapter:

```ts
const harness = createPiCodingAgentHarness({
	output: ({ response, session }) => ({
		response,
		activeTools: session.getActiveToolNames(),
		extensionErrors: session.resourceLoader.getExtensions().errors,
	}),
});
```

Assert application behavior on `result.output`. Assert model and tool traces on `result.session`, using
`vitest-evals` helpers such as `toolCalls(...)`.

### Writing comparative eval sets

Use `evalHarnessTable(...)` with Vitest's native `describe.for(...)` to run the same inputs against multiple harnesses.
Harnesses may differ by prompt, tools, skills, model, or any other Pi configuration:

```ts
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const TargetTaskJudge = createJudge<string, string>("TargetTaskJudge", ({ output }) => ({
	score: output === "expected result" ? 1 : 0,
}));

const harnessTable = evalHarnessTable(
	"target skill effectiveness",
	{
		baseline: withoutTargetSkillHarness,
		candidate: withTargetSkillHarness,
		repetitions: 6,
	},
);

describe.for(harnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval("target skill effectiveness", { harness, judges: [TargetTaskJudge], judgeThreshold: null }, (it) => {
		it("completes the target task", async ({ run }) => {
			await run("Complete the target task.");
		});
	});
});
```

Comparative suites should record correctness with deterministic or model-backed judges and set `judgeThreshold: null`.
This keeps a low score as an observation instead of making the Vitest invocation fail. Use hard assertions only for
suite invariants and infrastructure contracts. `expect.soft(...)` still fails the test and is not a scoring mechanism.

The Pi harness snapshots native session JSONL before deleting its temporary workspace. An eval-only `afterEach` hook
registers that snapshot against the explicit Vitest test task before reporters run.

Harness names must be stable and unique within an eval set. The grouping key combines repetition with a non-empty string
`input.id` when available, otherwise with a SHA-256 hash of strict canonical JSON input. Use `candidate` for one treatment
or `candidates` for multiple treatments. Each candidate is compared only with the declared baseline. For each matched
input and repetition, the reporter computes pass-rate lift from each run's recorded average judge score, treating a score
of at least `1` as passing. Lift is the candidate pass rate minus the baseline pass rate, in percentage points. Missing
judge scores are reported as incomplete observations. Tokens, latency, and estimated cost remain separate
candidate-minus-baseline paired deltas; missing telemetry remains unavailable. If execution-order randomization becomes
necessary, use Vitest's built-in sequence shuffling.

See the [`skill-eval-harness`](https://github.com/adewale/skill-eval-harness/) guidance for comparative-eval methodology,
repetition strategy, trustworthy judges, and telemetry interpretation.
