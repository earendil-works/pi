/**
 * TLA PreCheck formal model of the plan-mode state machine.
 *
 * Models the 3-phase planning flow (interview → plan generation → execution)
 * with optional high-accuracy Momus review loop. String fields are abstracted
 * to booleans; counters use rangeType. The "complete" phase is omitted as
 * analysis confirmed it's unreachable (dead state).
 *
 * Run: npx tla-precheck check plan-mode
 */
import { and, boolType, defineMachine, enumType, eq, lit, lte, not, optionType, or, rangeType, scalarVar, setVar, variable, } from "tla-precheck";
// Variable references
const phase = variable("phase");
const intent = variable("intent");
const clearanceComplete = variable("clearanceComplete");
const hasTodos = variable("hasTodos");
const hasPlanText = variable("hasPlanText");
const momusCycles = variable("momusCycles");
const momusVerdict = variable("momusVerdict");
const verifyingStep = variable("verifyingStep");
// Helpers — TLA PreCheck has no implies, so A → B = ¬A ∨ B
const implies = (a, b) => or(not(a), b);
// Full reset to initial state (reused by completeExecution + forceReset)
const resetUpdates = [
    setVar("phase", lit("idle")),
    setVar("intent", lit(null)),
    setVar("clearanceComplete", lit(false)),
    setVar("hasTodos", lit(false)),
    setVar("hasPlanText", lit(false)),
    setVar("momusCycles", lit(0)),
    setVar("momusVerdict", lit(null)),
    setVar("verifyingStep", lit(false)),
];
export const planModeMachine = defineMachine({
    version: 2,
    moduleName: "PlanMode",
    variables: {
        phase: scalarVar(enumType("idle", "interview", "planGen", "highAccuracy", "execution"), lit("idle")),
        intent: scalarVar(optionType(enumType("trivial", "simple", "complex")), lit(null)),
        clearanceComplete: scalarVar(boolType(), lit(false)),
        hasTodos: scalarVar(boolType(), lit(false)),
        hasPlanText: scalarVar(boolType(), lit(false)),
        momusCycles: scalarVar(rangeType(0, 3), lit(0)),
        momusVerdict: scalarVar(optionType(enumType("okay", "reject")), lit(null)),
        verifyingStep: scalarVar(boolType(), lit(false)),
    },
    actions: {
        // T2: Trivial intent → skip interview, go straight to planGen
        classifyTrivial: {
            params: {},
            guard: eq(phase, lit("idle")),
            updates: [
                setVar("phase", lit("planGen")),
                setVar("intent", lit("trivial")),
                setVar("clearanceComplete", lit(true)), // trivial auto-clears
            ],
        },
        // T1: Non-trivial (simple) → interview phase
        classifySimple: {
            params: {},
            guard: eq(phase, lit("idle")),
            updates: [setVar("phase", lit("interview")), setVar("intent", lit("simple"))],
        },
        // T1 variant: Non-trivial (complex) → interview phase
        classifyComplex: {
            params: {},
            guard: eq(phase, lit("idle")),
            updates: [setVar("phase", lit("interview")), setVar("intent", lit("complex"))],
        },
        // /plan command when idle → enter interview with null intent (no classification)
        manualPlanMode: {
            params: {},
            guard: eq(phase, lit("idle")),
            updates: [setVar("phase", lit("interview"))],
        },
        // Clearance markers accumulate during interview
        setClearance: {
            params: {},
            guard: and(eq(phase, lit("interview")), eq(clearanceComplete, lit(false))),
            updates: [setVar("clearanceComplete", lit(true))],
        },
        // T3: Interview complete → plan generation
        clearancePass: {
            params: {},
            guard: and(eq(phase, lit("interview")), eq(clearanceComplete, lit(true))),
            updates: [setVar("phase", lit("planGen"))],
        },
        // Plan extracted from agent output
        generatePlan: {
            params: {},
            guard: eq(phase, lit("planGen")),
            updates: [setVar("hasPlanText", lit(true)), setVar("hasTodos", lit(true))],
        },
        // T5: Start work directly (simple/trivial intent, no Momus review)
        startWork: {
            params: {},
            guard: and(eq(phase, lit("planGen")), eq(hasTodos, lit(true))),
            updates: [setVar("phase", lit("execution"))],
        },
        // T4: Enter high-accuracy Momus review loop
        startHighAccuracy: {
            params: {},
            guard: and(eq(phase, lit("planGen")), eq(hasTodos, lit(true))),
            updates: [
                setVar("phase", lit("highAccuracy")),
                setVar("momusCycles", lit(0)),
                setVar("momusVerdict", lit(null)),
            ],
        },
        // Momus returns OKAY
        momusApprove: {
            params: {},
            guard: eq(phase, lit("highAccuracy")),
            updates: [setVar("momusVerdict", lit("okay"))],
        },
        // T8: Momus returns REJECT (cycle 0 → 1)
        momusReject0: {
            params: {},
            guard: and(eq(phase, lit("highAccuracy")), eq(momusCycles, lit(0))),
            updates: [setVar("momusVerdict", lit("reject")), setVar("momusCycles", lit(1))],
        },
        // T8: Momus returns REJECT (cycle 1 → 2)
        momusReject1: {
            params: {},
            guard: and(eq(phase, lit("highAccuracy")), eq(momusCycles, lit(1))),
            updates: [setVar("momusVerdict", lit("reject")), setVar("momusCycles", lit(2))],
        },
        // T8: Momus returns REJECT (cycle 2 → 3, max reached)
        momusReject2: {
            params: {},
            guard: and(eq(phase, lit("highAccuracy")), eq(momusCycles, lit(2))),
            updates: [setVar("momusVerdict", lit("reject")), setVar("momusCycles", lit(3))],
        },
        // T6: Momus approved → start execution
        startWorkAfterReview: {
            params: {},
            guard: and(eq(phase, lit("highAccuracy")), eq(momusVerdict, lit("okay"))),
            updates: [setVar("phase", lit("execution"))],
        },
        // T7: Refine plan after Momus feedback → back to planGen
        refineFromReview: {
            params: {},
            guard: eq(phase, lit("highAccuracy")),
            updates: [setVar("phase", lit("planGen")), setVar("momusVerdict", lit(null))],
        },
        // "Start Work anyway" after max Momus rejections (no verdict requirement)
        forceStartWork: {
            params: {},
            guard: eq(phase, lit("highAccuracy")),
            updates: [setVar("phase", lit("execution"))],
        },
        // "Continue reviewing" after max cycles — reset counter, stay in highAccuracy
        resetMomusCycles: {
            params: {},
            guard: and(eq(phase, lit("highAccuracy")), eq(momusCycles, lit(3))),
            updates: [setVar("momusCycles", lit(0)), setVar("momusVerdict", lit(null))],
        },
        // Step verification toggle during execution
        startVerification: {
            params: {},
            guard: and(eq(phase, lit("execution")), eq(verifyingStep, lit(false))),
            updates: [setVar("verifyingStep", lit(true))],
        },
        endVerification: {
            params: {},
            guard: and(eq(phase, lit("execution")), eq(verifyingStep, lit(true))),
            updates: [setVar("verifyingStep", lit(false))],
        },
        // T10: All work complete → reset to idle
        completeExecution: {
            params: {},
            guard: and(eq(phase, lit("execution")), eq(hasTodos, lit(true))),
            updates: resetUpdates,
        },
        // T16: Force reset (/plan toggle from any non-idle phase)
        forceReset: {
            params: {},
            guard: not(eq(phase, lit("idle"))),
            updates: resetUpdates,
        },
    },
    invariants: {
        // INV-1: Can only execute if we have work items
        executionRequiresTodos: {
            description: "Execution phase requires todo items to exist",
            formula: implies(eq(phase, lit("execution")), eq(hasTodos, lit(true))),
        },
        // INV-2: Interview is only for non-trivial intents
        interviewRequiresNonTrivial: {
            description: "Interview phase never has trivial intent",
            formula: not(and(eq(phase, lit("interview")), eq(intent, lit("trivial")))),
        },
        // INV-3: High accuracy requires plan text to exist
        highAccuracyRequiresPlan: {
            description: "High accuracy phase requires plan text",
            formula: implies(eq(phase, lit("highAccuracy")), eq(hasPlanText, lit(true))),
        },
        // INV-4: Momus cycles never exceed max (3)
        momusCyclesBounded: {
            description: "Momus review cycles never exceed 3",
            formula: lte(momusCycles, lit(3)),
        },
        // INV-5: Entering planGen from interview requires clearance
        planGenRequiresClearance: {
            description: "Plan generation phase requires clearance to be complete",
            formula: implies(eq(phase, lit("planGen")), eq(clearanceComplete, lit(true))),
        },
        // INV-6: Idle state is always clean
        idleIsClean: {
            description: "Idle phase has all flags reset",
            formula: implies(eq(phase, lit("idle")), and(eq(clearanceComplete, lit(false)), eq(momusCycles, lit(0)), eq(momusVerdict, lit(null)), eq(verifyingStep, lit(false)))),
        },
        // INV-7: Step verification only happens during execution
        verifyingOnlyInExecution: {
            description: "Step verification flag is only true during execution",
            formula: implies(eq(verifyingStep, lit(true)), eq(phase, lit("execution"))),
        },
    },
    proof: {
        defaultTier: "pr",
        tiers: {
            pr: {
                domains: {},
                checks: { deadlock: false }, // idle is a valid terminal state
                budgets: {
                    maxEstimatedStates: 5_000,
                    maxEstimatedBranching: 50,
                },
            },
        },
    },
});
export default planModeMachine;
