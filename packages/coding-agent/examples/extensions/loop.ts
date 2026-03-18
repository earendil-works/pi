/**
 * Loop Extension for Pi — Recurring prompt scheduler
 *
 * Brings Claude Code's /loop to pi. Schedule prompts to fire automatically
 * at set intervals. Tasks run in the background while your session stays open.
 *
 * Usage:
 *   /loop 5m check if deployment finished
 *   /loop 1d summarize all commits from last 24 hours
 *   /loop 30m /skill:review-pr 1234
 *   remind me at 3 PM to push the release branch
 *   /loop-list
 *   /loop-cancel [id]
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoopEntry {
  id: string;
  intervalMs: number;
  prompt: string;
  createdAt: number;
  nextFireAt: number;
  fireCount: number;
  maxFires: number | null; // null = unlimited (3-day cap enforced separately)
  isOneShot: boolean;
  cronExpression: string | null;
  isCancelled: boolean;
}

interface LoopState {
  loops: LoopEntry[];
}

const LOOP_STATE_KEY = "loop-state";
const MAX_LOOP_DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_ACTIVE_LOOPS = 50;
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MIN_INTERVAL_MS = 60 * 1000; // 1 minute

// ---------------------------------------------------------------------------
// Interval parsing
// ---------------------------------------------------------------------------

function parseInterval(input: string): { ms: number; display: string } | null {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const ms = value * (multipliers[unit] || 0);

  // Round seconds up to nearest minute for cron-like granularity
  const display =
    value % 1 === 0
      ? `${value}${unit}`
      : unit === "s"
        ? `${Math.ceil(value / 60)}m`
        : `${value}${unit}`;

  return { ms: Math.round(ms), display };
}

// ---------------------------------------------------------------------------
// Natural language time parsing (one-shot reminders)
// ---------------------------------------------------------------------------

function parseNaturalTime(input: string): { ms: number; prompt: string } | null {
  const now = new Date();

  // "remind me at HH:MM to ..."
  const timeMatch = input.match(
    /remind\s+me\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)?\s+(?:to\s+)?(.+)/i,
  );
  if (timeMatch) {
    let hour = parseInt(timeMatch[1]);
    const minute = parseInt(timeMatch[2] || "0");
    const rest = timeMatch[3].trim();
    const isPM = /pm/i.test(input.slice(0, timeMatch.index! + timeMatch[0].length));
    const isAM = /am/i.test(input.slice(0, timeMatch.index! + timeMatch[0].length));

    if (!isAM && !isPM && hour < 7) hour += 12; // assume PM for reasonable times
    if (isPM && hour < 12) hour += 12;
    if (isAM && hour === 12) hour = 0;

    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1); // tomorrow if already passed

    return { ms: target.getTime() - now.getTime(), prompt: rest };
  }

  // "remind me in Xm to ..."
  const inMatch = input.match(/remind\s+me\s+in\s+(\d+(?:\.\d+)?)\s*(s|m|h|d)\s+(?:to\s+)?(.+)/i);
  if (inMatch) {
    const parsed = parseInterval(`${inMatch[1]}${inMatch[2]}`);
    if (parsed) return { ms: parsed.ms, prompt: inMatch[3].trim() };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Interval → cron expression (for display)
// ---------------------------------------------------------------------------

function intervalToCron(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);

  if (totalMinutes % (24 * 60) === 0) {
    const days = totalMinutes / (24 * 60);
    return `0 0 */${days} * *`;
  }
  if (totalMinutes % 60 === 0) {
    const hours = totalMinutes / 60;
    if (hours === 24) return `0 0 * * *`;
    return `0 */${hours} * * *`;
  }
  return `*/${totalMinutes} * * * *`;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function generateId(): string {
  return `loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// In-memory cache of the latest state (updated on every save)
let cachedState: LoopState | null = null;

function loadStateFromEntries(pi: ExtensionAPI): LoopState {
  // Try to read from the last entry in session
  // We store state via pi.appendEntry, so we need to reconstruct from entries
  // For simplicity, we use the in-memory cache and restore from entries on session_start
  if (cachedState) return cachedState;
  return { loops: [] };
}

function loadState(pi: ExtensionAPI): LoopState {
  return loadStateFromEntries(pi);
}

function saveState(pi: ExtensionAPI, state: LoopState): void {
  cachedState = state;
  pi.appendEntry(LOOP_STATE_KEY, state);
}

// ---------------------------------------------------------------------------
// Timer management
// ---------------------------------------------------------------------------

const activeTimers = new Map<string, NodeJS.Timeout>();

function clearAllTimers(): void {
  for (const [id, timer] of activeTimers) {
    clearInterval(timer);
    activeTimers.delete(id);
  }
}

function clearTimer(id: string): void {
  const timer = activeTimers.get(id);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Restore loops on session start
  pi.on("session_start", async (_event, ctx) => {
    clearAllTimers();

    // Rebuild state from session entries
    cachedState = null;
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.type === "custom" &&
        entry.customType === LOOP_STATE_KEY &&
        entry.data
      ) {
        cachedState = entry.data as LoopState;
        break;
      }
    }

    const state = loadState(pi);
    const now = Date.now();
    let restoredCount = 0;

    for (const loop of state.loops) {
      if (loop.isCancelled) continue;

      // Check 3-day expiry
      if (now - loop.createdAt > MAX_LOOP_DURATION_MS) {
        loop.isCancelled = true;
        continue;
      }

      // One-shot that already fired
      if (loop.isOneShot && loop.fireCount > 0) {
        loop.isCancelled = true;
        continue;
      }

      // Calculate next fire time
      if (now >= loop.nextFireAt) {
        // Already past due — fire immediately and advance
        const firesMissed = Math.floor((now - loop.nextFireAt) / loop.intervalMs);
        loop.nextFireAt += (firesMissed + 1) * loop.intervalMs;
        loop.fireCount += firesMissed;

        // Don't auto-fire on restore — just advance the timer
      }

      const delay = Math.max(0, loop.nextFireAt - now);
      restoredCount++;

      // Set up timer
      const timer = setTimeout(
        () => runLoopCycle(pi, ctx, loop),
        delay,
      );
      activeTimers.set(loop.id, timer as unknown as NodeJS.Timeout);

      // After first fire, switch to interval
      setTimeout(() => {
        if (activeTimers.has(loop.id)) {
          clearTimer(loop.id);
          const intervalTimer = setInterval(
            () => runLoopCycle(pi, ctx, loop),
            loop.intervalMs,
          );
          activeTimers.set(loop.id, intervalTimer);
        }
      }, delay);
    }

    saveState(pi, state);

    if (restoredCount > 0) {
      ctx.ui.notify(`Restored ${restoredCount} loop${restoredCount > 1 ? "s" : ""}`, "info");
    }
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", () => {
    clearAllTimers();
  });

  // Register /loop command
  pi.registerCommand("loop", {
    description: "Schedule a recurring prompt. Usage: /loop [interval] [prompt]",
    getArgumentCompletions: (prefix: string) => {
      if (!prefix) {
        return [
          { value: "5m ", label: "5m — every 5 minutes" },
          { value: "10m ", label: "10m — every 10 minutes (default)" },
          { value: "30m ", label: "30m — every 30 minutes" },
          { value: "1h ", label: "1h — every hour" },
          { value: "1d ", label: "1d — every day" },
        ];
      }
      return null;
    },
    handler: async (args, ctx) => {
      const state = loadState(pi);

      // Check active loop count
      const activeLoops = state.loops.filter((l) => !l.isCancelled);
      if (activeLoops.length >= MAX_ACTIVE_LOOPS) {
        ctx.ui.notify(
          `Maximum ${MAX_ACTIVE_LOOPS} active loops reached. Cancel some with /loop-cancel.`,
          "warning",
        );
        return;
      }

      const input = args?.trim();
      if (!input) {
        ctx.ui.notify("Usage: /loop [interval] [prompt]", "warning");
        return;
      }

      // Try natural language first (one-shot reminders)
      const naturalTime = parseNaturalTime(input);
      if (naturalTime) {
        const loop: LoopEntry = {
          id: generateId(),
          intervalMs: naturalTime.ms,
          prompt: naturalTime.prompt,
          createdAt: Date.now(),
          nextFireAt: Date.now() + naturalTime.ms,
          fireCount: 0,
          maxFires: 1,
          isOneShot: true,
          cronExpression: null,
          isCancelled: false,
        };

        state.loops.push(loop);
        saveState(pi, state);

        // Schedule one-shot
        const timer = setTimeout(() => {
          runLoopCycle(pi, ctx, loop);
          loop.isCancelled = true;
          saveState(pi, state);
        }, naturalTime.ms);
        activeTimers.set(loop.id, timer as unknown as NodeJS.Timeout);

        const fireTime = new Date(Date.now() + naturalTime.ms);
        const timeStr = fireTime.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });

        ctx.ui.notify(
          `⏰ One-shot loop scheduled for ${timeStr}: ${naturalTime.prompt.slice(0, 60)}`,
          "info",
        );
        updateWidget(pi, ctx, state);
        return;
      }

      // Parse interval + prompt
      const intervalMatch = input.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)\s+([\s\S]+)$/);
      if (!intervalMatch) {
        // No interval — use default 10m
        const prompt = input;
        createRecurringLoop(pi, ctx, state, DEFAULT_INTERVAL_MS, "10m", prompt, null, 1);
        return;
      }

      const intervalStr = `${intervalMatch[1]}${intervalMatch[2]}`;
      const prompt = intervalMatch[3].trim();
      const parsed = parseInterval(intervalStr);

      if (!parsed || parsed.ms < MIN_INTERVAL_MS) {
        ctx.ui.notify("Minimum interval is 1 minute (1m)", "warning");
        return;
      }

      createRecurringLoop(pi, ctx, state, parsed.ms, parsed.display, prompt, null, 1);
    },
  });

  // Register /loop-list command
  pi.registerCommand("loop-list", {
    description: "Show all active loops",
    handler: async (_args, ctx) => {
      const state = loadState(pi);
      const active = state.loops.filter((l) => !l.isCancelled);

      if (active.length === 0) {
        ctx.ui.notify("No active loops", "info");
        return;
      }

      const lines = active.map((l) => {
        const interval = formatInterval(l.intervalMs);
        const type = l.isOneShot ? "⚡" : "🔁";
        const fires = l.maxFires ? `${l.fireCount}/${l.maxFires}` : `${l.fireCount} fires`;
        const expires = new Date(l.createdAt + MAX_LOOP_DURATION_MS);
        const expiresStr = expires.toLocaleDateString([], {
          month: "short",
          day: "numeric",
        });
        const preview = l.prompt.length > 40 ? `${l.prompt.slice(0, 40)}...` : l.prompt;
        return `${type} ${l.id}  ${interval}  ${preview}  [${fires}]  (expires ${expiresStr})`;
      });

      ctx.ui.notify(`${active.length} active loop${active.length > 1 ? "s" : ""}`, "info");
      for (const line of lines) {
        ctx.ui.notify(line, "info");
      }
    },
  });

  // Register /loop-cancel command
  pi.registerCommand("loop-cancel", {
    description: "Cancel an active loop. Usage: /loop-cancel [id] (omit to cancel all)",
    handler: async (args, ctx) => {
      const state = loadState(pi);
      const active = state.loops.filter((l) => !l.isCancelled);

      if (active.length === 0) {
        ctx.ui.notify("No active loops to cancel", "info");
        return;
      }

      if (!args?.trim()) {
        // Cancel all
        for (const loop of active) {
          loop.isCancelled = true;
          clearTimer(loop.id);
        }
        saveState(pi, state);
        ctx.ui.notify(`Cancelled ${active.length} loop${active.length > 1 ? "s" : ""}`, "success");
        updateWidget(pi, ctx, state);
        return;
      }

      // Cancel specific loop
      const target = args.trim().toLowerCase();
      const found = state.loops.find(
        (l) =>
          !l.isCancelled &&
          (l.id === target || l.id.toLowerCase().startsWith(target)),
      );

      if (!found) {
        ctx.ui.notify(`No active loop matching "${args.trim()}"`, "warning");
        return;
      }

      found.isCancelled = true;
      clearTimer(found.id);
      saveState(pi, state);
      ctx.ui.notify(`Cancelled loop ${found.id}`, "success");
      updateWidget(pi, ctx, state);
    },
  });

  // Register tool so LLM can also schedule loops
  pi.registerTool({
    name: "loop_schedule",
    label: "Loop Schedule",
    description:
      "Schedule a recurring task or one-shot reminder. The task fires as a user prompt at the specified interval.",
    promptSnippet: "Schedule recurring tasks or timed reminders",
    parameters: Type.Object({
      interval: Type.Optional(
        Type.String({
          description:
            'Interval string like "5m", "1h", "1d". Default: "10m". Use "one-shot" for a single fire with the "fire_in" parameter.',
        }),
      ),
      fire_in: Type.Optional(
        Type.String({
          description: 'For one-shot reminders: "5m", "2h", "3:00pm". Prompt fires once after this duration.',
        }),
      ),
      prompt: Type.String({
        description: "The prompt to execute on each cycle. Can include slash commands.",
      }),
      max_fires: Type.Optional(
        Type.Integer({
          description:
            "Maximum number of times to fire. Default: unlimited (3-day expiry still applies).",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(pi);
      const activeLoops = state.loops.filter((l) => !l.isCancelled);

      if (activeLoops.length >= MAX_ACTIVE_LOOPS) {
        return {
          content: [
            {
              type: "text",
              text: `Maximum ${MAX_ACTIVE_LOOPS} active loops reached. Cancel some with /loop-cancel.`,
            },
          ],
          details: { loops: describeLoops(activeLoops) },
        };
      }

      // One-shot mode
      if (params.fire_in) {
        const natural = parseNaturalTime(`remind me in ${params.fire_in} to ${params.prompt}`);
        if (!natural) {
          const parsed = parseInterval(params.fire_in);
          if (!parsed) {
            return {
              content: [
                {
                  type: "text",
                  text: `Invalid fire_in: "${params.fire_in}". Use formats like "5m", "1h", "3:00pm".`,
                },
              ],
              details: {},
            };
          }
          return createLoopFromTool(pi, ctx, state, {
            intervalMs: parsed.ms,
            prompt: params.prompt,
            maxFires: 1,
            isOneShot: true,
          });
        }
        return createLoopFromTool(pi, ctx, state, {
          intervalMs: natural.ms,
          prompt: natural.prompt,
          maxFires: 1,
          isOneShot: true,
        });
      }

      // Recurring mode
      const intervalStr = params.interval || "10m";
      const parsed = parseInterval(intervalStr);

      if (!parsed || parsed.ms < MIN_INTERVAL_MS) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid interval: "${intervalStr}". Minimum is 1m. Use formats like "5m", "1h", "1d".`,
            },
          ],
          details: {},
        };
      }

      return createLoopFromTool(pi, ctx, state, {
        intervalMs: parsed.ms,
        prompt: params.prompt,
        maxFires: params.max_fires ?? null,
        isOneShot: false,
      });
    },
  });

  // Register tool to list/cancel loops programmatically
  pi.registerTool({
    name: "loop_manage",
    label: "Loop Manage",
    description: "List or cancel active loops.",
    promptSnippet: "List or cancel scheduled loops",
    parameters: Type.Object({
      action: Type.String({
        description: 'Action: "list" or "cancel"',
      }),
      id: Type.Optional(
        Type.String({
          description: "Loop ID to cancel (omit to cancel all)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = loadState(pi);
      const active = state.loops.filter((l) => !l.isCancelled);

      if (params.action === "list") {
        if (active.length === 0) {
          return {
            content: [{ type: "text", text: "No active loops." }],
            details: { loops: [] },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `${active.length} active loop(s):\n${active.map(describeLoop).join("\n")}`,
            },
          ],
          details: { loops: describeLoops(active) },
        };
      }

      if (params.action === "cancel") {
        if (active.length === 0) {
          return {
            content: [{ type: "text", text: "No active loops to cancel." }],
            details: {},
          };
        }

        if (params.id) {
          const found = state.loops.find(
            (l) => !l.isCancelled && l.id.toLowerCase().startsWith(params.id!.toLowerCase()),
          );
          if (!found) {
            return {
              content: [{ type: "text", text: `No active loop matching "${params.id}"` }],
              details: {},
            };
          }
          found.isCancelled = true;
          clearTimer(found.id);
          saveState(pi, state);
          updateWidget(pi, ctx, state);
          return {
            content: [{ type: "text", text: `Cancelled loop ${found.id}` }],
            details: {},
          };
        }

        // Cancel all
        for (const loop of active) {
          loop.isCancelled = true;
          clearTimer(loop.id);
        }
        saveState(pi, state);
        updateWidget(pi, ctx, state);
        return {
          content: [{ type: "text", text: `Cancelled ${active.length} loop(s)` }],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: 'Invalid action. Use "list" or "cancel".' }],
        details: {},
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRecurringLoop(
  pi: ExtensionAPI,
  ctx: any,
  state: LoopState,
  intervalMs: number,
  display: string,
  prompt: string,
  maxFires: number | null,
  fireCount: number,
): void {
  const cron = intervalToCron(intervalMs);
  const loop: LoopEntry = {
    id: generateId(),
    intervalMs,
    prompt,
    createdAt: Date.now(),
    nextFireAt: Date.now() + intervalMs,
    fireCount,
    maxFires,
    isOneShot: false,
    cronExpression: cron,
    isCancelled: false,
  };

  state.loops.push(loop);
  saveState(pi, state);

  // Schedule
  const timer = setInterval(() => runLoopCycle(pi, ctx, loop), intervalMs);
  activeTimers.set(loop.id, timer);

  const expires = new Date(Date.now() + MAX_LOOP_DURATION_MS);
  const expiresStr = expires.toLocaleDateString([], { month: "short", day: "numeric" });

  ctx.ui.notify(
    `🔁 Loop ${loop.id}: every ${display} → ${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""} (expires ${expiresStr})`,
    "success",
  );
  updateWidget(pi, ctx, state);
}

function createLoopFromTool(
  pi: ExtensionAPI,
  ctx: any,
  state: LoopState,
  config: {
    intervalMs: number;
    prompt: string;
    maxFires: number | null;
    isOneShot: boolean;
  },
): any {
  const loop: LoopEntry = {
    id: generateId(),
    intervalMs: config.intervalMs,
    prompt: config.prompt,
    createdAt: Date.now(),
    nextFireAt: Date.now() + config.intervalMs,
    fireCount: 0,
    maxFires: config.maxFires,
    isOneShot: config.isOneShot,
    cronExpression: config.isOneShot ? null : intervalToCron(config.intervalMs),
    isCancelled: false,
  };

  state.loops.push(loop);
  saveState(pi, state);

  if (config.isOneShot) {
    const timer = setTimeout(() => {
      pi.sendUserMessage(loop.prompt);
      loop.fireCount = 1;
      loop.isCancelled = true;
      clearTimer(loop.id);
      saveState(pi, state);
      updateWidget(pi, ctx, loadState(pi));
    }, config.intervalMs);
    activeTimers.set(loop.id, timer as unknown as NodeJS.Timeout);
  } else {
    const timer = setInterval(() => runLoopCycle(pi, ctx, loop), config.intervalMs);
    activeTimers.set(loop.id, timer);
  }

  const type = config.isOneShot ? "One-shot" : "Recurring";
  const interval = formatInterval(config.intervalMs);
  const maxStr = config.maxFires ? ` (max ${config.maxFires} fires)` : "";

  updateWidget(pi, ctx, state);

  return {
    content: [
      {
        type: "text",
        text: `${type} loop ${loop.id} scheduled: every ${interval}${maxStr}\nPrompt: ${config.prompt}\nCancel with: /loop-cancel ${loop.id}`,
      },
    ],
    details: { loopId: loop.id, interval, prompt: config.prompt, isOneShot: config.isOneShot },
  };
}

function runLoopCycle(pi: ExtensionAPI, ctx: any, loop: LoopEntry): void {
  if (loop.isCancelled) {
    clearTimer(loop.id);
    return;
  }

  // Check 3-day expiry
  if (Date.now() - loop.createdAt > MAX_LOOP_DURATION_MS) {
    loop.isCancelled = true;
    clearTimer(loop.id);
    saveState(pi, state);
    updateWidget(pi, ctx, loadState(pi));
    ctx.ui.notify(`Loop ${loop.id} expired (3-day limit)`, "warning");
    return;
  }

  // Check max fires
  if (loop.maxFires !== null && loop.fireCount >= loop.maxFires) {
    loop.isCancelled = true;
    clearTimer(loop.id);
    saveState(pi, state);
    updateWidget(pi, ctx, loadState(pi));
    return;
  }

  loop.fireCount++;
  loop.nextFireAt = Date.now() + loop.intervalMs;
  const currentState = loadState(pi);
  saveState(pi, currentState);
  updateWidget(pi, ctx, currentState);

  // Fire the prompt
  ctx.ui.setStatus("loop", `🔁 Firing loop ${loop.id} (#${loop.fireCount})...`);
  pi.sendUserMessage(loop.prompt);

  // Clear status after a delay
  setTimeout(() => ctx.ui.setStatus("loop", undefined), 3000);
}

function updateWidget(pi: ExtensionAPI, ctx: any, state: LoopState): void {
  const active = state.loops.filter((l) => !l.isCancelled);

  if (active.length === 0) {
    ctx.ui.setWidget("loop", undefined);
    return;
  }

  const lines = active.map((l) => {
    const type = l.isOneShot ? "⚡" : "🔁";
    const interval = formatInterval(l.intervalMs);
    const preview = l.prompt.length > 30 ? `${l.prompt.slice(0, 30)}...` : l.prompt;
    return `${type} ${l.id.split("-")[1]}  ${interval}  ${preview}`;
  });

  ctx.ui.setWidget("loop", [`Active loops (${active.length}/${MAX_ACTIVE_LOOPS}):`, ...lines]);
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(ms % 3_600_000 === 0 ? 0 : 1)}h`;
  return `${(ms / 86_400_000).toFixed(ms % 86_400_000 === 0 ? 0 : 1)}d`;
}

function describeLoop(l: LoopEntry): string {
  const type = l.isOneShot ? "⚡" : "🔁";
  const interval = formatInterval(l.intervalMs);
  const preview = l.prompt.length > 50 ? `${l.prompt.slice(0, 50)}...` : l.prompt;
  const fires = l.maxFires ? `${l.fireCount}/${l.maxFires}` : `${l.fireCount}`;
  return `${type} ${l.id}  every ${interval}  ${preview}  [${fires} fires]`;
}

function describeLoops(loops: LoopEntry[]): any[] {
  return loops.map((l) => ({
    id: l.id,
    interval: formatInterval(l.intervalMs),
    prompt: l.prompt,
    fireCount: l.fireCount,
    maxFires: l.maxFires,
    isOneShot: l.isOneShot,
    createdAt: l.createdAt,
    nextFireAt: l.nextFireAt,
  }));
}
