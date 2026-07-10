/**
 * Goal Extension — Entry Point
 *
 * Thin shell that delegates all wiring to GoalExtension.
 *
 * File layout:
 *   - goal-mode.ts       (pure state machine, #46)
 *   - goal-persistence.ts (session entry save/load, #46)
 *   - goal-types.ts       (shared types, #46)
 *   - goal-injector.ts    (injection text generator, #47)
 *   - goal-extension.ts   (wiring: hooks, tools, command, status, #53)
 *   - tools/create-goal.ts (#47)
 *   - tools/update-goal.ts (#47)
 *   - tools/get-goal.ts   (#47)
 *   - index.ts            (entry point — this file)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalExtension } from "./goal-extension.ts";

export default function goalExtension(pi: ExtensionAPI): void {
	new GoalExtension(pi);
}
