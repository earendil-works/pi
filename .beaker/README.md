# Pi harness optimization on JobBench

This integration evaluates Pi's TypeScript source harness on the tasks supplied
by the selected JobBench dataset. The configuration selects the `pi-jobbench` Beaker
integration. Importing the integration does not create a dataset or launch a run.

The editable surface includes Pi's agent loop, agent session, system prompt,
message conversion, compaction, and tool implementations. The Python bridge,
source resolver, provider adapters, benchmark, judge, and evaluation policy remain
outside that surface. See `beaker_integration.py` for the exact source paths.

## Benchmark and model configuration

`jobbench/protocol.json` records benchmark pins and Pi execution defaults.
`beaker.yaml`'s `integrations.pi-jobbench.scorer_model` is the only judge model
setting, used by both hosted and local scoring:

- Dataset: `JobBench/job-bench@d43a66575635da0d3f6cb9a20976dc1a60f3ffc9`.
- Evaluator: `Job-Bench/job-bench-eval@660b33a86ed032559df0b2fdc1ad38cf7ceb83f3`.
- Default Pi model: `openai:gpt-6-luna`, overridable per launch; thinking level
  `high`, 3599-second wall-clock budget (under Beaker's 3600-second case limit).
- Judge: `openai:gpt-6-luna`, set independently of the Pi model. This uses
  JobBench's official rubric logic with a custom judge model; compare scores
  within the same judge configuration.
- Objective: `0.5 * jobbench_weighted_score + 0.5 * criteria_pass_rate`.
  - `jobbench_weighted_score` is JobBench's official per-task rubric-weighted
    score, normalized to `[0, 1]`; compare this field with JobBench results.
    A rubric earns its full weight only when every criterion passes, so a task
    can score 0 while most criteria pass.
  - `criteria_pass_rate` is the fraction of graded criteria that pass, excluding
    criteria in zero-weight rubrics; it gives the optimizer a denser signal.
  - The unweighted rubric pass rate (`rubric_pass_rate`) is diagnostic only.
  Average task scores with equal task weights when reporting a subset aggregate.

Task selection and train/test assignment belong to the supplied dataset, not
the evaluation protocol. No task list or split size is fixed in this repository.
Use distinct tasks for train and test, and do not use held-out tasks to select
candidate changes. A subset score is not a full JobBench leaderboard result.

## Task instructions and reference files

`TASK_INSTRUCTIONS.txt` is a dataset file, not a tracked file in this Pi repository.
For example, the pinned original for `data_entry_keyers/task1` is available on
[Hugging Face](https://huggingface.co/datasets/JobBench/job-bench/resolve/d43a66575635da0d3f6cb9a20976dc1a60f3ffc9/dataset/data_entry_keyers/task1/task_folder/TASK_INSTRUCTIONS.txt).

The loader reads its contents into the Beaker row's `input.instructions` field.
During case preparation it downloads the original file and the other files under
that task's `task_folder/`, verifies their sizes and hashes, and attaches them as
case files. The adapter copies those files into the task workspace, where Pi
reads `task_folder/TASK_INSTRUCTIONS.txt` and adjacent reference paths.
Pi's input prompt is the upstream runners' prompt verbatim, with absolute workspace
paths; like upstream, it points to the instructions file instead of inlining it. `RUBRICS.json` stays with
the evaluator and is not copied into Pi's workspace. Local evaluation retains the
downloaded instructions at `<run-dir>/workspace/task_folder/TASK_INSTRUCTIONS.txt`;
hosted workspaces are temporary.

## Prepare the local checkout

Use Linux or macOS with Python 3.12+, Node.js 22.19+, and `uv`. Docker is needed
for official Excel scoring; generating deliverables with Pi does not use Docker.

```bash
cd /path/to/pi
UV_PROJECT_ENVIRONMENT=.beaker/.venv uv sync --locked --group dev
npm ci --ignore-scripts
npm run hydrate:model-data
```

Python dependencies are evaluation tooling; Pi's normal Node runtime does not
import Beaker. The Node subprocess uses this checkout's `source-resolver.ts` and
`local-runner-cli.ts`, so edited candidate TypeScript is loaded without a build.
No npm registry version of Pi is used as the evaluated harness. Generation runs
Node directly in the task workspace, without a task container or network relay.

The JobBench adapter uses Node.js 24.19.0 supplied by the pinned
[`nodejs-wheel-binaries`](https://pypi.org/project/nodejs-wheel-binaries/24.19.0/)
evaluation dependency. It does not depend on the system's Node version.
When a candidate copy has no Node dependencies, the adapter runs
`npm ci --ignore-scripts --include=dev`. Existing installations are reused.
An OS file lock serializes dependency setup when concurrent rollouts share a
checkout; task execution remains parallel. Setup commands have a ten-minute
timeout and receive no provider API key.

When model data is absent, setup downloads the immutable revision in
`nix/model-catalog.json`, verifies its SHA-256, and uses Pi's existing offline
hydrator. It never replaces candidate source with an installed Pi package or
fetches a moving model catalog. npm and hydration failures include bounded logs
in the case error. Pi failures include its structured error or stderr before
the temporary workspace is removed, with the candidate API key redacted.

The official judge recalculates spreadsheet formulas with its pinned LibreOffice
runtime. Install Docker and prepare that runtime once before scoring:

```bash
.beaker/.venv/bin/python -c 'import sys; sys.path.insert(0, ".beaker/vendor/jobbench/eval"); from jobbench_eval.calc import setup_runtime; setup_runtime()'
```

The unchanged calculator Dockerfile and locally extended extractor sources are included under
`vendor/jobbench/`, alongside their Apache-2.0 license and `PROVENANCE.json` with
the original upstream Git blob hashes and the local changes. Missing Docker or failed extraction is an
evaluation error, not a score of zero. `JOBBENCH_CALC_NATIVE=1` is only suitable
inside the exact upstream calculation image; it is not a generic LibreOffice
fallback.

Hosted setup installs `curl` (the task prompt allows online search), `docker.io`, `util-linux`, and `tesseract-ocr` (for tasks with scanned
images) through `apt_install`. Before loading cases,
`JobBenchSetup.prepare_run` connects to Docker or starts an attempt-owned daemon
inside Beaker's Modal VM, builds the unchanged upstream calculator Dockerfile,
and verifies formula recalculation with the official worker. It does not build
any Pi image. The calculator image is independent of Pi's candidate sources and
is reused throughout the attempt. Startup/build
failures therefore stop setup before paid rollouts. The daemon receives no
provider or Beaker API credentials and is stopped when the attempt closes. Its
mount namespace is private, so Docker's internal mounts do not prevent removal
of the attempt's temporary files. An externally managed daemon is left untouched.
The trusted image build uses host networking; workbook calculation retains the
official read-only, offline container restrictions. Local structural smoke
does not start Docker, and local scoring still uses the Docker setup above.

An existing daemon with the official calculator image already loaded skips the
image build. A fresh hosted daemon currently builds it once per attempt; its
temporary image store is removed on teardown. Reusing this fixed image across
hosted runs requires a prebuilt image in a registry or a persistent image cache.
Only Excel calculation uses the container; document extraction and judge API
calls run in the evaluator.

## Structural smoke: no model calls

For an existing Beaker dataset, pass its immutable selector:

```bash
.beaker/.venv/bin/beaker run smoke --strict \
  --integration-id pi-jobbench --dataset NAME@REVISION
```

To build a dataset from upstream tasks, prepare a JSON file outside the checkout
(for example `/tmp/jobbench-split.json`) with `train` and `test` arrays of task
paths. Both arrays must be nonempty, and task paths must be unique across them.
Choose the tasks and split sizes for your experiment; no default selection is
applied. From the checkout root, run this snippet with `.beaker/.venv/bin/python`:

```python
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, ".beaker")
from jobbench.data import jobbench_dataset

split = json.loads(Path("/tmp/jobbench-split.json").read_text(encoding="utf-8"))
with jobbench_dataset(train_tasks=split["train"], test_tasks=split["test"]) as dataset:
    subprocess.run(
        [
            ".beaker/.venv/bin/beaker", "run", "smoke", "--strict",
            "--integration-id", "pi-jobbench",
            "--config", json.dumps({"local_dataset_path": str(dataset)}),
        ],
        check=True,
    )
```

This fetches real instructions, rubrics, and task files at the pinned revision,
checks input sizes and content hashes, and validates the Beaker integration.
Generated `train.jsonl` and `test.jsonl` exist only in an OS-managed temporary
directory that is removed when the context exits. Do not commit generated rows,
raw datasets, or runtime workspaces.

Smoke does **not** execute Pi, run the judge, validate paid API authentication,
or prove Docker is available. It is a structural check, not an evaluated score.

## Run a real task locally

These commands make paid API calls. Set `OPENAI_API_KEY` for generation with the default model, or
`OPENROUTER_API_KEY` for an `openrouter:` model. For
local judging with the configured OpenRouter model, set `JUDGE_API_BASE` to
`https://openrouter.ai/api/v1` and `JUDGE_API_KEY` to your OpenRouter API key.
Keep local secrets in `.beaker/.env` and explicitly load that file in your shell.
The Python scripts do not automatically source `.env` files.

Generate and score a task from the pinned dataset revision, using a new output
directory outside the checkout. For example:

```bash
.beaker/.venv/bin/python .beaker/evaluate.py \
  --task human_resources_specialists/task1 \
  --run-dir /tmp/pi-jobbench-hr-run-001
```

To generate without calling the judge, append `--phase generate`. To score the
saved deliverables later, reuse the task and run directory with `--phase score`.
The scorer verifies the saved task and protocol before reusing an output.

To change the rollout model, choose an OpenAI or OpenRouter model in the Beaker
launch or pass `--model openai:gpt-6-sol` to the local command. A bare API ID such
as `gpt-6-sol` means OpenAI. Without an override, `jobbench/protocol.json`'s
`agent_model` is the default. The adapter records the actual selected model in
the saved protocol and traces; it does not require a particular GPT version.
The TypeScript runner supports the OpenAI and OpenRouter providers only.

When scoring an existing local run, its recorded rollout model is retained even
if the default has since changed. An explicit `--model` must match that recorded
model. Scoring uses the current judge configuration and records it in `score.json`,
so saved deliverables can be re-scored after a judge change. Keep the judge fixed
while comparing harness candidates.

Hosted judging uses the model and credentials supplied by
`scoring_inference_target()` for Beaker's dedicated scorer accounting. Local
judging reads the YAML next to this integration, independently of the shell's
working directory. Google models use Google's OpenAI-compatible endpoint by
default; set `JUDGE_API_BASE` to override it. Other providers require both
`JUDGE_API_BASE` and `JUDGE_API_KEY` locally. `score.json` records the actual judge
model used, independently of the saved rollout protocol. The local extraction changes under
`vendor/jobbench/` are documented in `PROVENANCE.json`. Each rubric request is capped at 64,000 completion
tokens, reasoning included, so a looping response fails fast and is retried.
Empty submissions record `scorer_model: null`: they score zero without a judge call
or provider credentials.

`jobbench/judging.py` preserves the pinned rubric criteria, image
selection, and result layout, sends the full extracted text in one request per rubric attempt, and uses `response_format: json_schema` with strict
typed fields and an exact criterion count. It validates criterion indices before
accepting a result and, like upstream, scores the rubric from `rubric_passed`. JSON recovery, rubric weights, and score aggregation still
use the upstream helpers. Saved score reports fingerprint the extractor and the
judge adapter; scores from different evidence implementations must be compared
by rejudging the same deliverables under both versions.

The scorer sends all extracted text in the initial request for each rubric.
There is no per-file or per-sheet character cap, no SQLite row sampling, and no
evidence-reading tool or follow-up conversation. All rubric prompts are prepared
and checked before any judge request starts. The verified GPT-6 Luna context
window is 1,050,000 tokens (OpenAI model documentation, checked 2026-11-18).
The check counts the complete messages and JSON schema using `tiktoken`'s
`o200k_base` encoding. This is an estimate: tiktoken has no GPT-6-specific mapping.
It reserves an additional 10% of text tokens plus 4,096 for tokenizer differences
and framing, 36,000 per selected image (the maximum auto-detail patch budget),
and 64,000 for output including reasoning. The estimates and reserves appear in
each rubric's `context` report and informational checks. A budget overflow raises
an evaluation error before any requests, without truncation or a zero score.
Provider context-limit errors also propagate immediately. Changing the scorer
requires reviewing the explicit model/vision budget in `prepare_rubric()`; unknown
models fail closed rather than inheriting GPT-6 Luna's limit.

Notebook code views replace large base64 literals with length/hash references,
so embedded input data cannot consume the prompt before methods and
results. The original notebook remains unchanged. Encoded payloads are represented
by length/hash references; all other extracted code and saved text outputs are sent.
Excel views include saved conditional-format rules, their differential styles,
and native chart OOXML. These establish saved structure and conditions; they are
not rendered screenshots and do not by themselves establish visual readability.
The pinned, offline LibreOffice calculator and formula semantics are unchanged.

Rubrics run on at most ten worker threads and remain in their original order.
Each rubric has at most three attempts, with a two-second pause between attempts.
Only failed rubrics retry: malformed JSON, invalid fields or verdicts, incomplete
responses, and transient API errors. SDK retries are disabled to keep this budget
bounded. Authentication, permission, and invalid request errors fail immediately;
the adapter never falls back to unstructured output or turns judge errors into
zero scores. Exhausted errors identify the rubric and the validation or API cause.

Gemini 3 and GPT-6 requests omit the upstream `temperature=0` override and use the
provider's default sampling: Gemini 3 deprecates the setting and GPT-6 rejects it.
Other models retain the upstream temperature. Judge selection still comes only from `beaker.yaml`.

Every generation creates its own `workspace/task_folder/`, `workspace/output/`,
`workspace/scratch/`, and Pi HOME/config under the run directory. Pi starts with
that workspace as `cwd` and loads the current candidate's sources directly.
Personal extensions and instructions do not influence this benchmark path.

The child environment receives the selected provider's key (`OPENAI_API_KEY` or
`OPENROUTER_API_KEY`) and the existing provider-proxy settings, excluding judge and
Beaker credentials. Hosted OpenAI and OpenRouter requests use
Beaker's existing provider proxy without an additional integration relay.
Generation has no task-level filesystem or network sandbox: normal process
permissions determine access outside the workspace. The workspace and prompt
are organizational conventions, not access controls.

The adapter waits for the complete session. On timeout or cancellation it stops
Node and invokes Pi's native cleanup for detached shell processes. The adapter
does not build a Docker image or start a container for generation. Ordinary
`scripts/pi_harness.py` behavior is unchanged.

The run directory retains the deliverables, raw Pi transcript/result JSON,
stderr diagnostics, and a rubric-level `score.json` with the judge's extraction
diagnostics. An empty submission is a
normal zero. Provider, timeout, transport, malformed-judge, and infrastructure
failures propagate as errors instead of being turned into incorrect answers.

## Beaker contract and limitations

The loader stages only `task_folder/` files using `CaseFile`; task rubrics stay in
trusted `Case.expected`. Each `run_case` loads the current candidate's native Pi
sources in a Node subprocess, then transports binary deliverables in `CaseResult.context` before
cleaning its workspace. The scorer does not depend on an evaluator-local path.
The sample output contains the final response, file manifest, and native usage
statistics. Passing and failing rubric criteria become `CaseScore.checks`.

Before the workspace is deleted, including when Pi fails, a `pi.jobbench.workspace`
trace stage records every file the agent wrote outside `task_folder/`
(deliverables and `scratch/`): text files inline (up to 200,000 characters each),
and every file as a trace artifact under its SHA-256, up to 16 MiB per rollout.
Judge inputs have no character cap; the separate trace preview limit above does
not affect scoring. The standalone vendored `judge.py` CLI includes extraction
changes but retains upstream request/error handling. Use `.beaker/evaluate.py`
or the Beaker scorer for the context guard and strict evaluation path.

- Binary submissions currently have a 23.9 MiB total limit, leaving room for base64
  encoding inside Beaker's 32 MiB result envelope (beaker-runtime 0.3.27 or later).
  Exceeding this limit is an explicit transport failure; submissions are never
  silently truncated.
- Evaluation configuration selects the model, thinking level, and timeout.
  Pi runs with the evaluator user's filesystem and network permissions. Beaker's
  editable scopes constrain candidate proposals; they do not sandbox Pi's tools.
- The `pi.jobbench` stage replays Pi's session after the rollout: one model call
  per assistant turn, followed by one tool call per tool Pi ran, with its
  arguments and result. Spans are emitted after the run, so their timings are not
  real; `pi.duration_ms` carries Pi's measured duration. Image bytes and provider
  signatures are omitted.
- Hosted Node startup, npm dependencies, and pinned catalog hydration are
  prepared by the adapter. End-to-end model execution and scoring still need
  hosted validation. Hosted setup prepares the exact upstream calculator
  container described above; it requires a VM sandbox that supports Docker.

No benchmark, judge, or optimization API calls are made by importing the integration.
