---
name: workflows
description: Orchestrate many one-shot subagents from a code mode script (tools.agent) for audits, reviews, migrations, research and plan comparisons. Use when a task needs more agents than one conversation can coordinate, or a cross-checked result.
---

# Workflows: orchestrating one-shot agents from code mode

A workflow is a code mode script that runs many one-shot agents (`tools.agent`) and combines their results. The plan lives in the script: loops, branching and intermediate results stay in script variables, and only the script's return value reaches the main conversation. Needs p2's `codemode` and `agent` plugins, both loaded by default (see [p2 notes](p2-notes.md), **One-shot agents**). `test/p2/workflows.test.ts` runs every pattern below against the fake provider.

```js
const value = await tools.agent({
	prompt, // the task; give absolute paths and say whether it may change files
	schema, // JSON Schema of the answer; the call resolves to the parsed, validated value
	label, // optional: the row name on the script's tool card
	model, // optional 'provider/modelId'; default: the caller's
	thinkingLevel, // optional
	tools, // optional subset of read, write, edit, bash, send_file, artifact; default: all
});
```

Each call runs a fresh conversation. Its answer is parsed as JSON and validated; a failure is sent back to the same agent, up to 3 attempts, then the call rejects. Agents are listed as rows on the script's tool card, where their transcripts open (read-only). Their cost counts toward the session total.

## When to use one

| Use | Instead |
| --- | --- |
| The same step across many items (files, issues, endpoints) | One agent or a loop of tool calls when the items fit in one context |
| A result that should be cross-checked: findings verified by an independent agent | A single pass when being wrong is cheap |
| Several independent drafts weighed against each other | One draft when the design space is small |
| Repeating until a check passes or nothing new turns up | A plain `bash` loop when no judgment is needed |

A persistent `subagent` fits ongoing delegated work that you talk to again. A script blocks the main turn until it ends, so keep a run to minutes; try it on a small slice first.

## Practices

- **Small schemas.** Use `required`, `enum`, `maxItems` and `maxLength`. Filtering and ranking then happen in plain JavaScript, not by parsing prose.
- **Isolate failures.** Inside `Promise.all`, append `.catch((error) => fallback)` to each call, so one failed agent does not end the run. Count and report the fallbacks.
- **Independent checks.** Verifiers and judges use another model family than the agents whose work they check, and are told to refute rather than confirm.
- **Explicit scope.** Give absolute paths and the exact command to inspect (`git show <commit> -- <paths>`). Say "read-only: change nothing" when that is the intent, because the `bash` tool can change files. Grant only the tools needed.
- **Bounded cost.** Cap the fan-out (`maxItems`, `slice`), the rounds, and what gets verified (for example only medium/high severity). Use cheaper models for wide phases and a stronger one for the judge.
- **Labels.** Give each agent a short `label`, so the tool card's rows say what each one did.
- **Return a summary.** Return counts plus the kept results, not every intermediate value: the return value enters the main context.

## Pattern: fan out, then adversarially verify

One reviewer per area, then an independent verifier per serious finding; only confirmed findings come back.

```js
const repo = "/abs/path/to/repo";
const areas = [
	{ label: "review: server", files: "src/server", focus: "authorization and validation" },
	{ label: "review: worker", files: "src/worker", focus: "restart and replay safety" },
];
const findingSchema = {
	type: "object", required: ["findings"], additionalProperties: false,
	properties: { findings: { type: "array", maxItems: 5, items: {
		type: "object", required: ["file", "line", "severity", "title", "explanation"], additionalProperties: false,
		properties: {
			file: { type: "string" }, line: { type: "integer" },
			severity: { enum: ["high", "medium", "low"] },
			title: { type: "string", maxLength: 120 }, explanation: { type: "string", maxLength: 800 },
		} } } },
};
const verdictSchema = {
	type: "object", required: ["verdict", "reason"], additionalProperties: false,
	properties: { verdict: { enum: ["confirmed", "refuted", "unsure"] }, reason: { type: "string", maxLength: 600 } },
};

const reviews = await Promise.all(areas.map((area) =>
	tools.agent({
		label: area.label, model: "anthropic/claude-sonnet-5-5", tools: ["read", "bash"],
		prompt: `Review ${area.files} in ${repo} (read-only: change nothing). Focus: ${area.focus}. Report only real bugs, with the line. An empty list is fine.`,
		schema: findingSchema,
	}).catch((error) => ({ findings: [], error: error.message })),
));
const candidates = reviews.flatMap((review) => review.findings).filter((finding) => finding.severity !== "low");
const verdicts = await Promise.all(candidates.map((finding, index) =>
	tools.agent({
		label: `verify ${index + 1}: ${finding.title}`.slice(0, 80), model: "openai-codex/gpt-5.5", tools: ["read", "bash"],
		prompt: `A reviewer claims: ${finding.title} at ${finding.file}:${finding.line} in ${repo}.\n${finding.explanation}\nTry hard to refute it by reading the code and its callers (read-only). Confirm only if you can trace it concretely.`,
		schema: verdictSchema,
	}).catch((error) => ({ verdict: "unsure", reason: error.message })),
));
return {
	confirmed: candidates.filter((_, index) => verdicts[index].verdict === "confirmed"),
	refuted: verdicts.filter((verdict) => verdict.verdict === "refuted").length,
	unsure: verdicts.filter((verdict) => verdict.verdict === "unsure").length,
	reviewerErrors: reviews.filter((review) => review.error).map((review) => review.error),
};
```

## Pattern: draft from several angles, then judge

Independent drafts with different constraints, then one judge that checks their claims, scores them and merges the plan it would implement.

```js
const problem = "…what needs designing, with the files to read…";
const angles = [
	{ label: "plan: smallest change", angle: "Minimize new code; reuse what exists." },
	{ label: "plan: proper design", angle: "Design the clean end state, whatever it costs." },
	{ label: "plan: user experience", angle: "Start from what the user sees, then derive the implementation." },
];
const planSchema = {
	type: "object", required: ["summary", "design", "steps", "risks", "effort"], additionalProperties: false,
	properties: {
		summary: { type: "string", maxLength: 300 }, design: { type: "string", maxLength: 2500 },
		steps: { type: "array", maxItems: 8, items: { type: "string" } },
		risks: { type: "array", maxItems: 5, items: { type: "string" } },
		effort: { enum: ["S", "M", "L"] },
	},
};
const plans = await Promise.all(angles.map((angle) =>
	tools.agent({
		label: angle.label, tools: ["read", "bash"], schema: planSchema,
		prompt: `${problem}\n\nAngle: ${angle.angle}\nRead the code first (read-only), then draft a plan grounded in the actual APIs.`,
	}),
));
const verdict = await tools.agent({
	label: "judge", model: "openai-codex/gpt-5.5", thinkingLevel: "high", tools: ["read", "bash"],
	prompt: `${problem}\n\nScore these plans after checking their claims against the code (read-only), pick a winner, write the merged plan you would implement, and list rejected ideas with reasons.\n\n${plans.map((plan, index) => `## ${angles[index].label}\n${JSON.stringify(plan)}`).join("\n\n")}`,
	schema: {
		type: "object", required: ["winner", "merged", "steps", "rejected"], additionalProperties: false,
		properties: {
			winner: { type: "string" }, merged: { type: "string", maxLength: 2000 },
			steps: { type: "array", maxItems: 8, items: { type: "string" } },
			rejected: { type: "array", maxItems: 6, items: { type: "string" } },
		},
	},
});
return { summaries: plans.map((plan, index) => [angles[index].label, plan.effort, plan.summary]), verdict };
```

## Pattern: fix until a check passes

Run the check, hand the errors to a fixing agent, and stop on success or when rounds stop making progress. The check runs through `tools.bash`, so the script sees the real result rather than an agent's report of it. `tools.bash` rejects on a nonzero exit; the error's `structuredOutput` holds `{ output, exitCode }`.

```js
const repo = "/abs/path/to/repo";
let previous = Infinity;
let stalled = 0;
for (let round = 1; round <= 5; round++) {
	const check = await tools
		.bash({ command: `set -o pipefail; cd ${repo} && npm run check 2>&1 | tail -80` })
		.catch((error) => error.structuredOutput ?? { output: error.message, exitCode: 1 });
	if (check.exitCode === 0) return { passed: true, rounds: round - 1 };
	const errors = (check.output.match(/error/gi) ?? []).length;
	stalled = errors >= previous ? stalled + 1 : 0;
	if (stalled >= 2) return { passed: false, reason: "two rounds without progress", output: check.output };
	previous = errors;
	await tools.agent({
		label: `fix round ${round}`, tools: ["read", "edit", "bash"],
		prompt: `In ${repo}, fix these check errors without changing behavior or weakening types:\n${check.output}`,
		schema: { type: "object", required: ["changed"], properties: { changed: { type: "array", items: { type: "string" } } } },
	});
}
return { passed: false, reason: "round limit" };
```

Agents share the working tree: run fixers one at a time, or give parallel fixers disjoint files (or separate `git worktree` checkouts).

## Pattern: search in rounds until nothing new turns up

Each round asks for items not found yet; stop after a round adds nothing.

```js
const found = new Map();
for (let round = 1; round <= 6; round++) {
	const known = [...found.keys()];
	const batch = await tools.agent({
		label: `search round ${round}`, tools: ["read", "bash"],
		prompt: `…what to find…\nAlready known (do not repeat): ${JSON.stringify(known)}`,
		schema: {
			type: "object", required: ["items"], properties: { items: { type: "array", maxItems: 10, items: {
				type: "object", required: ["id", "evidence"], properties: { id: { type: "string" }, evidence: { type: "string" } },
			} } },
		},
	});
	const fresh = batch.items.filter((item) => !found.has(item.id));
	if (fresh.length === 0) break;
	for (const item of fresh) found.set(item.id, item);
}
return [...found.values()];
```

## Limits

- The script occupies the main turn; there is no background run yet.
- No concurrency cap: what runs at once is what the script awaits together. Providers may rate-limit wide fan-outs.
- A restart resumes the script: finished agent calls return their recorded results, running ones reattach to their conversations.
- One-shot agents cannot be prompted from the UI; to follow up, use a persistent `subagent` instead.
