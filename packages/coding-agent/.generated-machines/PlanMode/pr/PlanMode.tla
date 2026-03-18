---- MODULE PlanMode ----
EXTENDS FiniteSets, Integers, TLC

\* Generated. Treat as a build artifact.
Null == "__NULL__"


VARIABLES phase, intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep

vars == <<phase, intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>

TypeOK ==
  /\ phase \in {"idle", "interview", "planGen", "highAccuracy", "execution"}
  /\ intent \in {"trivial", "simple", "complex"} \cup {Null}
  /\ clearanceComplete \in BOOLEAN
  /\ hasTodos \in BOOLEAN
  /\ hasPlanText \in BOOLEAN
  /\ momusCycles \in 0..3
  /\ momusVerdict \in {"okay", "reject"} \cup {Null}
  /\ verifyingStep \in BOOLEAN

executionRequiresTodos ==
  (~(phase = "execution")) \/ (hasTodos = TRUE)
interviewRequiresNonTrivial ==
  ~((phase = "interview") /\ (intent = "trivial"))
highAccuracyRequiresPlan ==
  (~(phase = "highAccuracy")) \/ (hasPlanText = TRUE)
momusCyclesBounded ==
  momusCycles <= 3
planGenRequiresClearance ==
  (~(phase = "planGen")) \/ (clearanceComplete = TRUE)
idleIsClean ==
  (~(phase = "idle")) \/ ((clearanceComplete = FALSE) /\ (momusCycles = 0) /\ (momusVerdict = Null) /\ (verifyingStep = FALSE))
verifyingOnlyInExecution ==
  (~(verifyingStep = TRUE)) \/ (phase = "execution")

classifyTrivial ==
  /\ phase = "idle"
  /\ phase' = "planGen"
  /\ intent' = "trivial"
  /\ clearanceComplete' = TRUE
  /\ UNCHANGED <<hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>
classifySimple ==
  /\ phase = "idle"
  /\ phase' = "interview"
  /\ intent' = "simple"
  /\ UNCHANGED <<clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>
classifyComplex ==
  /\ phase = "idle"
  /\ phase' = "interview"
  /\ intent' = "complex"
  /\ UNCHANGED <<clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>
manualPlanMode ==
  /\ phase = "idle"
  /\ phase' = "interview"
  /\ UNCHANGED <<intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>
setClearance ==
  /\ (phase = "interview") /\ (clearanceComplete = FALSE)
  /\ clearanceComplete' = TRUE
  /\ UNCHANGED <<phase, intent, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>
clearancePass ==
  /\ (phase = "interview") /\ (clearanceComplete = TRUE)
  /\ phase' = "planGen"
  /\ UNCHANGED <<intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>
generatePlan ==
  /\ phase = "planGen"
  /\ hasPlanText' = TRUE
  /\ hasTodos' = TRUE
  /\ UNCHANGED <<phase, intent, clearanceComplete, momusCycles, momusVerdict, verifyingStep>>
startWork ==
  /\ (phase = "planGen") /\ (hasTodos = TRUE)
  /\ phase' = "execution"
  /\ UNCHANGED <<intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>
startHighAccuracy ==
  /\ (phase = "planGen") /\ (hasTodos = TRUE)
  /\ phase' = "highAccuracy"
  /\ momusCycles' = 0
  /\ momusVerdict' = Null
  /\ UNCHANGED <<intent, clearanceComplete, hasTodos, hasPlanText, verifyingStep>>
momusApprove ==
  /\ phase = "highAccuracy"
  /\ momusVerdict' = "okay"
  /\ UNCHANGED <<phase, intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, verifyingStep>>
momusReject0 ==
  /\ (phase = "highAccuracy") /\ (momusCycles = 0)
  /\ momusVerdict' = "reject"
  /\ momusCycles' = 1
  /\ UNCHANGED <<phase, intent, clearanceComplete, hasTodos, hasPlanText, verifyingStep>>
momusReject1 ==
  /\ (phase = "highAccuracy") /\ (momusCycles = 1)
  /\ momusVerdict' = "reject"
  /\ momusCycles' = 2
  /\ UNCHANGED <<phase, intent, clearanceComplete, hasTodos, hasPlanText, verifyingStep>>
momusReject2 ==
  /\ (phase = "highAccuracy") /\ (momusCycles = 2)
  /\ momusVerdict' = "reject"
  /\ momusCycles' = 3
  /\ UNCHANGED <<phase, intent, clearanceComplete, hasTodos, hasPlanText, verifyingStep>>
startWorkAfterReview ==
  /\ (phase = "highAccuracy") /\ (momusVerdict = "okay")
  /\ phase' = "execution"
  /\ UNCHANGED <<intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>
refineFromReview ==
  /\ phase = "highAccuracy"
  /\ phase' = "planGen"
  /\ momusVerdict' = Null
  /\ UNCHANGED <<intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, verifyingStep>>
forceStartWork ==
  /\ phase = "highAccuracy"
  /\ phase' = "execution"
  /\ UNCHANGED <<intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict, verifyingStep>>
resetMomusCycles ==
  /\ (phase = "highAccuracy") /\ (momusCycles = 3)
  /\ momusCycles' = 0
  /\ momusVerdict' = Null
  /\ UNCHANGED <<phase, intent, clearanceComplete, hasTodos, hasPlanText, verifyingStep>>
startVerification ==
  /\ (phase = "execution") /\ (verifyingStep = FALSE)
  /\ verifyingStep' = TRUE
  /\ UNCHANGED <<phase, intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict>>
endVerification ==
  /\ (phase = "execution") /\ (verifyingStep = TRUE)
  /\ verifyingStep' = FALSE
  /\ UNCHANGED <<phase, intent, clearanceComplete, hasTodos, hasPlanText, momusCycles, momusVerdict>>
completeExecution ==
  /\ (phase = "execution") /\ (hasTodos = TRUE)
  /\ phase' = "idle"
  /\ intent' = Null
  /\ clearanceComplete' = FALSE
  /\ hasTodos' = FALSE
  /\ hasPlanText' = FALSE
  /\ momusCycles' = 0
  /\ momusVerdict' = Null
  /\ verifyingStep' = FALSE
forceReset ==
  /\ ~(phase = "idle")
  /\ phase' = "idle"
  /\ intent' = Null
  /\ clearanceComplete' = FALSE
  /\ hasTodos' = FALSE
  /\ hasPlanText' = FALSE
  /\ momusCycles' = 0
  /\ momusVerdict' = Null
  /\ verifyingStep' = FALSE

Init ==
  /\ phase = "idle"
  /\ intent = Null
  /\ clearanceComplete = FALSE
  /\ hasTodos = FALSE
  /\ hasPlanText = FALSE
  /\ momusCycles = 0
  /\ momusVerdict = Null
  /\ verifyingStep = FALSE

Next ==
  \/ classifyTrivial
  \/ classifySimple
  \/ classifyComplex
  \/ manualPlanMode
  \/ setClearance
  \/ clearancePass
  \/ generatePlan
  \/ startWork
  \/ startHighAccuracy
  \/ momusApprove
  \/ momusReject0
  \/ momusReject1
  \/ momusReject2
  \/ startWorkAfterReview
  \/ refineFromReview
  \/ forceStartWork
  \/ resetMomusCycles
  \/ startVerification
  \/ endVerification
  \/ completeExecution
  \/ forceReset

EquivalenceNext ==
  \/ classifyTrivial
  \/ classifySimple
  \/ classifyComplex
  \/ manualPlanMode
  \/ setClearance
  \/ clearancePass
  \/ generatePlan
  \/ startWork
  \/ startHighAccuracy
  \/ momusApprove
  \/ momusReject0
  \/ momusReject1
  \/ momusReject2
  \/ startWorkAfterReview
  \/ refineFromReview
  \/ forceStartWork
  \/ resetMomusCycles
  \/ startVerification
  \/ endVerification
  \/ completeExecution
  \/ forceReset

Spec == Init /\ [][Next]_vars
EquivalenceSpec == Init /\ [][EquivalenceNext]_vars

====