/**
 * Agent runner for the NLT Coding Agent: one governed coding turn, run with sandbox tools and a free gateway model.
 *
 * What it composes, and what it does not decide:
 *   1. The crisis gate runs first, on the user's prompt. A turn that is not clearly allowed does not start, so no
 *      sandbox is touched and no model is called. (Fail closed: only a literal `allowed: true` passes.)
 *   2. The model is chosen from the live gateway catalog and must be free right now (`pickFreeModel`). If none is,
 *      the turn does not run. Model identifiers are never written into source.
 *   3. The turn runs inside the agent's one sandbox, under its lock (`withAgentSandbox`). The tools are the Pi
 *      bash/read/write/edit tools bound to sandbox operations, and every tool call is reviewed by the harness
 *      policy inside those operations. Built-in (host) tools are disabled, so the host filesystem and shell are
 *      never reachable from the model.
 *   4. The gateway credential is read inside the call (`gatewayToken`), held in memory, and never placed in the
 *      sandbox, a file the model can read, the session, or a log.
 *
 * Model output is proposed intent, not authority: nothing here lets the model change the gate, the model choice,
 * the sandbox settings, or the policy. Nothing in the application calls this yet; the route that will is off unless
 * the owner sets a per-environment flag (see NLTPI-MVP-005).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { GATEWAY_MODELS_URL, NoFreeModelError, isFreeLanguageModel, pickFreeModel, type GatewayCatalogModel } from "../gateway/free-models.ts";
import {
  SandboxBusyError,
  SandboxTurnTimeoutError,
  withAgentSandbox,
  type AgentSandboxOptions,
  type SandboxClient,
} from "../sandbox/lifecycle.ts";
import { createSandboxToolOperations, type SandboxOperationsOptions } from "../sandbox/operations.ts";

/** Base URL of the gateway's OpenAI-compatible API. */
export const GATEWAY_API_URL = GATEWAY_MODELS_URL.replace(/\/models$/, "");
const GATEWAY_PROVIDER_ID = "nlt-gateway";
/** Where the agent works inside the sandbox. The Vercel Sandbox working directory; confirm on first real use. */
export const DEFAULT_WORKSPACE_ROOT = "/vercel/sandbox";

type CustomTools = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["customTools"]>;

export interface GateResult {
  allowed: boolean;
  blockedReason?: string | null;
  crisisLevel?: string | null;
}

/** What the runner needs to talk to a model: a ModelRuntime and the model in it. */
export interface ModelBinding {
  modelRuntime: ModelRuntime;
  model: NonNullable<Parameters<typeof createAgentSession>[0]>["model"];
  /** Releases anything created for the binding (temporary files). */
  dispose?: () => Promise<void>;
}

export interface AgentRunnerDeps {
  /** The crisis gate. Called with the user's prompt before anything else. */
  gate: (prompt: string) => Promise<GateResult>;
  sandboxClient: SandboxClient;
  /** Reads the gateway credential. Called inside the turn, never at module level. */
  gatewayToken: () => Promise<string>;
  /** Chooses the model. Default: the best free tool-capable model in the live catalog. */
  pickModel?: () => Promise<GatewayCatalogModel>;
  /** Builds the model binding. Default: the Vercel AI Gateway with `gatewayToken`. Tests inject an offline one. */
  bindModel?: (model: GatewayCatalogModel, token: string) => Promise<ModelBinding>;
  workspaceRoot?: string;
  sandbox?: AgentSandboxOptions;
  operations?: Omit<SandboxOperationsOptions, "root">;
}

export interface AgentTurnInput {
  prompt: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolStart?: (name: string) => void;
}

export type AgentTurnResult =
  | { status: "completed"; text: string; model: string }
  | { status: "blocked"; reason: string; crisisLevel: string | null }
  | { status: "busy" }
  | { status: "no_free_model"; reason: string }
  | { status: "timed_out" }
  | { status: "aborted"; reason: string }
  | { status: "error"; reason: string };

/** Registers the gateway as an OpenAI-compatible provider for one free model, with the token held in memory. */
export async function bindGatewayModel(model: GatewayCatalogModel, token: string): Promise<ModelBinding> {
  const dir = await mkdtemp(join(tmpdir(), "nlt-agent-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(GATEWAY_PROVIDER_ID, {
    name: "Vercel AI Gateway",
    baseUrl: GATEWAY_API_URL,
    apiKey: token,
    api: "openai-completions",
    models: [
      {
        id: model.id,
        name: model.name ?? model.id,
        reasoning: false,
        input: ["text"],
        // Free by construction: pickFreeModel only returns zero-priced models.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.context_window ?? 128_000,
        maxTokens: model.max_tokens ?? 8_192,
      },
    ],
  });
  const bound = modelRuntime.getModel(GATEWAY_PROVIDER_ID, model.id);
  if (!bound) throw new Error("The chosen model could not be registered");
  return { modelRuntime, model: bound, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** Thrown inside the turn when the caller cancels; mapped to the `aborted` status. */
class CallerAbortedError extends Error {
  constructor() {
    super("The turn was cancelled by the caller");
    this.name = "CallerAbortedError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** Runs one governed coding turn. Never throws for an expected refusal; returns a status instead. */
export async function runAgentTurn(deps: AgentRunnerDeps, input: AgentTurnInput): Promise<AgentTurnResult> {
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    return { status: "error", reason: "Empty prompt" };
  }

  // 1. Crisis gate. Anything but a literal `allowed: true` stops here.
  let gate: GateResult;
  try {
    gate = await deps.gate(input.prompt);
  } catch (error) {
    return { status: "blocked", reason: `The safety check could not run: ${describeError(error)}`, crisisLevel: null };
  }
  if (gate?.allowed !== true) {
    return { status: "blocked", reason: gate?.blockedReason ?? "Blocked by the safety check", crisisLevel: gate?.crisisLevel ?? null };
  }

  // 2. A free model, chosen from the live catalog.
  let chosen: GatewayCatalogModel;
  try {
    chosen = await (deps.pickModel ?? (() => pickFreeModel({ requireToolUse: true })))();
  } catch (error) {
    if (error instanceof NoFreeModelError) return { status: "no_free_model", reason: error.message };
    return { status: "error", reason: describeError(error) };
  }

  // L3: re-validate an injected model choice before binding.
  if (deps.pickModel && !isFreeLanguageModel(chosen)) {
    return { status: "no_free_model", reason: `Rejected injected model ${chosen.id}: not a free model` };
  }

  // 3. The turn, inside the one sandbox, under its lock.
  const root = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  let binding: ModelBinding | undefined;
  let session: AgentSession | undefined;
  try {
    const text = await withAgentSandbox(
      deps.sandboxClient,
      async (sandbox, turnSignal) => {
        // M1: create the workspace root outside the confinement check so that
        // `confineReal`/`realpath` can succeed even when the root does not exist yet.
        try {
          await sandbox.fs.access(root);
        } catch {
          await sandbox.fs.mkdir(root, { recursive: true });
        }
        const ops = createSandboxToolOperations(sandbox, { ...deps.operations, root });
        await ops.write.mkdir(root);

        // The credential is read now, inside the request, and goes only to the model runtime.
        const token = await deps.gatewayToken();
        binding = await (deps.bindModel ?? bindGatewayModel)(chosen, token);

        // The tool factories return differently typed definitions; the session takes them as one list.
        const tools: CustomTools = [
          createBashToolDefinition(root, { operations: ops.bash, exposeSessionEnvironment: false }) as CustomTools[number],
          createReadToolDefinition(root, { operations: ops.read, autoResizeImages: false }) as CustomTools[number],
          createWriteToolDefinition(root, { operations: ops.write }) as CustomTools[number],
          createEditToolDefinition(root, { operations: ops.edit }) as CustomTools[number],
        ];

        // No host resources: no extensions, skills, prompt files or context files from the machine running this.
        const scratch = await mkdtemp(join(tmpdir(), "nlt-agent-res-"));
        const resourceLoader = new DefaultResourceLoader({
          cwd: root,
          agentDir: scratch,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          settingsManager: SettingsManager.inMemory(),
        });
        await resourceLoader.reload();

        try {
          ({ session } = await createAgentSession({
            // The session's cwd is the sandbox workspace: Pi hands it to the tools, and it is shown to the model.
            // Nothing is read from it on this machine (no context files, extensions or skills are loaded).
            cwd: root,
            agentDir: scratch,
            modelRuntime: binding.modelRuntime,
            model: binding.model,
            noTools: "builtin",
            customTools: tools,
            resourceLoader,
            sessionManager: SessionManager.inMemory(root),
            settingsManager: SettingsManager.inMemory(),
          }));

          let out = "";
          const unsubscribe = session.subscribe((event) => {
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
              out += event.assistantMessageEvent.delta;
              input.onText?.(event.assistantMessageEvent.delta);
            } else if (event.type === "tool_execution_start") {
              input.onToolStart?.(event.toolName);
            }
          });

          // Stop the model run when the caller aborts or the turn deadline arrives.
          const stop = () => void session?.abort();
          input.signal?.addEventListener("abort", stop, { once: true });
          turnSignal.addEventListener("abort", stop, { once: true });

          try {
            // A cancellation or deadline that already happened means the model is never called.
            if (input.signal?.aborted) throw new CallerAbortedError();
            if (turnSignal.aborted) throw new SandboxTurnTimeoutError();
            await session.prompt(input.prompt);
          } finally {
            input.signal?.removeEventListener("abort", stop);
            turnSignal.removeEventListener("abort", stop);
            unsubscribe();
          }
          if (turnSignal.aborted) throw new SandboxTurnTimeoutError();
          if (input.signal?.aborted) throw new CallerAbortedError();
          return out;
        } finally {
          session?.dispose();
          await rm(scratch, { recursive: true, force: true });
        }
      },
      deps.sandbox,
    );
    return { status: "completed", text, model: chosen.id };
  } catch (error) {
    if (error instanceof SandboxBusyError) return { status: "busy" };
    if (error instanceof SandboxTurnTimeoutError) return { status: "timed_out" };
    if (error instanceof CallerAbortedError) return { status: "aborted", reason: error.message };
    return { status: "error", reason: describeError(error) };
  } finally {
    await binding?.dispose?.().catch(() => undefined);
  }
}
