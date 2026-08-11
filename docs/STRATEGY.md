# Strategy

## Objective

Earn test-token PnL by acting on authoritative information before a shallow LMSR fully incorporates it. The agent does not trade generic sentiment, copy unverified posts, or manufacture activity.

## Decision sequence

1. Discover the official competition markets and organizer-designated sources.
2. Record source observations and content hashes.
3. Produce a market-specific probability assessment with an expiry and explicit rationale.
4. Refuse stale, low-confidence, non-authoritative, contradictory, or weak-edge assessments.
5. Quote the exact share amount against the live LMSR.
6. Recalculate edge after price impact and fees; halve size until constraints pass or refuse.
7. Persist the intent, approve only the bounded maximum cost, submit once, and reconcile the receipt.
8. Redeem settled winners and liquidate only when the SDK reports an eligible terminal state.

## Priority

Deterministic official releases and observable events have priority over forecasts. Before resolution, position size reflects uncertainty and LMSR depth. After a decisive primary-source release, speed and source integrity matter more than narrative complexity.

The first locked forecast adapter is the NSIDC Arctic-extent market. It uses the latest official extent and the trailing 46 observations, applies only same-horizon historical changes, and estimates the threshold probability with Laplace smoothing. The rule, 8-point net-edge floor, and allocation limits were committed before organizer funding arrived.
