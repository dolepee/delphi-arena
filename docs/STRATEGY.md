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
7. For a deterministic tournament result, require a flat reconciled wallet and a valid settlement before final scoring. Prefer a maximum-cost payout that clears fresh official third-place PnL by at least 300 TST; otherwise permit only the bounded near-podium route described below.
8. Persist the intent, approve only the bounded maximum cost, repeat the fresh book/quote/podium guard, submit once, and reconcile the receipt.
9. Redeem settled winners and liquidate only when the SDK reports an eligible terminal state.

Forecasts and published results are separate evidence classes. Forecasts retain the locked 8-point net-edge floor. A published result may use the 2-point floor only when the organizer-named authoritative source contains the exact target-date value and the adapter deterministically maps it to the contract outcome.

Full-live residual capacity below 5 TST is ignored. This prevents repeated dust top-ups when a refreshed mark price moves the percentage-based market cap by a negligible amount.

## Priority

Deterministic official releases and observable events have priority over forecasts. Before resolution, position size reflects uncertainty and LMSR depth. After a decisive primary-source release, speed and source integrity matter more than narrative complexity.

For the final tournament window, the isolated exact-result profile can spend at most 1,350 TST, 95% of equity/cash, and 20 points of LMSR impact. It is unavailable to forecasts, schedules, canaries, nonflat books, stale quotes, or stale leaderboards. The primary route requires the maximum-cost winning payout to clear the higher of live or projected third-place PnL by at least 300 TST. A secondary `near_podium_exact` route is allowed only for the same deterministic published-result evidence when the winning payout profit floor is at least 500 TST, projected PnL finishes no more than the larger of one starting bankroll or 25% of the podium target behind it, and the SDK settlement deadline is at least 18 hours before competition close. The settlement deadline is a schedule, not a guarantee against oracle failure. A confirmed published-result trade for the same market and outcome cannot be replayed from a later quote.

The first locked forecast adapter is the NSIDC Arctic-extent market. It uses the latest official extent and the trailing 46 observations, applies only same-horizon historical changes, and estimates the threshold probability with Laplace smoothing. The rule, 8-point net-edge floor, and allocation limits were committed before organizer funding arrived.

Official schedule facts are a separate evidence class, not forecasts or resolved results. The first adapter covers CRS-35 and acts only when NASA's own mission page identifies CRS-35, explicitly says `No Earlier Than Fall 2026`, and exposes an earliest event timestamp after the contract deadline. It fails closed on missing or contradictory fields and requires at least a 4-point post-fee net edge. Exact published results retain the 2-point floor; ordinary forecasts retain the 8-point floor.
