/**
 * TypeBox parameter schemas for the EnterPlanMode/ExitPlanMode tools
 * (openclaude-style plan mode entry/exit; both are parameterless — the plan
 * content always lives in the plan file on disk).
 */

import { Type } from "typebox";

export const EnterPlanModeParams = Type.Object({});
export const ExitPlanModeParams = Type.Object({});
