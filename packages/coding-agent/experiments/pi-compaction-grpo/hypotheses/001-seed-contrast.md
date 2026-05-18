# Hypothesis 001: Seed Contrast

## Family
H0 - reward/data smoke.

## Claim
A tiny GRPO dataset contrasting operational compaction summaries against generic
and hallucinated summaries should train without schema errors and create an
adapter that moves away from empty/overconfident summaries.

## Mechanism
The reward spread is large: calibrated good summaries score around 0.80, while
generic and hallucinated summaries score around 0.19-0.21. Even a small group
should provide a clear policy-gradient direction for Pi-compatible structure plus
state fidelity.

## Falsification Plan
If Kiln rejects the JSONL, the data schema or chat message shape is wrong. If
training succeeds but evaluation on held-out calibration-style cases does not
improve over base, move to a larger generated prompt set before tuning GRPO
hyperparameters.

## Verdict
Pending.

