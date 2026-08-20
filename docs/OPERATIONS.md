# Operations

## Current state

The funded canary and leaderboard-recognition checks completed on August 12. Full-live trading and settlement are active on the VPS under systemd timers. The runtime still requires the protected live confirmation plus the canary and full-live approval records on every write path.

The authoritative-result lane runs through `delphi-event.timer` every 15 seconds. It accepts only high-confidence `published_result` assessments at probability `0.99`. If exact evidence contradicts an existing position, that position may be closed, but a new entry is deferred to the next cycle so the official leaderboard and a flat wallet book can reconcile first. If fresh exact evidence instead confirms an existing position, the same serialized event cycle refreshes that short-lived assessment and applies the conservative profit-take rule; it sells only when the full-position minimum proceeds preserve at least a 3% return and the remaining hold edge is at most two points, then waits for a later flat cycle before another entry. With a flat book, the primary route requires a fresh maximum-cost quote to clear the higher of live or projected official third-place PnL plus 300 TST. The bounded `near_podium_exact` fallback instead requires at least 500 TST of winning payout profit, a residual deficit no larger than the greater of one starting bankroll or 25% of that podium target, and an SDK settlement deadline at least 18 hours before competition close. Every payout-based route requires a valid settlement deadline before final scoring; the deadline does not guarantee oracle success. The buy path repeats the book, quote, podium, settlement, and execution-flag guards both before intent preparation and after token approval, then submits once against the original atomic ceiling. It performs no write when no exact result exists. Install and enable both `delphi-event.service` and `delphi-event.timer` together; `OnBootSec=10s` ensures the lane starts after a fresh boot. New deployments must start with `DELPHI_EVENT_EXECUTION_ENABLED=false`; observe a production dry run and verify wallet, source semantics, latency, locks, ledger state, and podium freshness before setting it to `true`.

`delphi-opportunities.timer` compares every open listing with `config/opportunities.json` once per minute. Classification is also enforced centrally before candidate selection or any opposing-position projection. Unknown and `abstain` markets are ineligible; `forecast_only` cannot enter the result lane; result-capable evidence must match an explicitly mapped outcome after its earliest decisive timestamp.

`delphi-podium.timer` reads the official competition page every ten seconds and atomically stores the third-place and registered-wallet rows under `podium/latest.json`. Exact-result execution requires this snapshot to be no more than 45 seconds old and reconciles the official Conviction PnL/cash against a fresh flat SDK book. The ranking comparison uses official PnL, never the page's occasionally inconsistent account-value field. The reliability monitor checks both podium units.

Before an eligible exact market's event window, `npm run preapprove-exact` may set an exact 1,350 TST allowance for each currently open, explicitly result-capable market. This is an onchain approval, not a trade; it is intentionally manual and bounded so an event cycle does not lose its fresh quote while waiting for approval confirmation.

`delphi-leaderboard.timer` runs independently every four hours and never acquires the trading write lock. It reconstructs the active competition table from the official market catalog, Goldsky gateway events, onchain TST balances, and current contract marks. Events for gateway markets outside the official competition catalog are counted and excluded. Any missing balance or unpriced held position fails the snapshot instead of publishing a partial rank. Timestamped and latest snapshots are private runtime state under `leaderboard/`; alerts cover third-place threshold movement, new markets traded by the top five, large podium moves, and monitor failure.

`delphi-monitor.timer` runs every minute without jitter. It checks event and opportunity timer activity, successful-cycle freshness, authoritative-source health for result-capable markets, unresolved trade/exit intents, gas reserve, and drift in the immutable release target or policy hash. The first reviewed deployment records a private baseline; any later deployment must deliberately replace that baseline only after release parity is verified. Alert state is deduplicated and clears on recovery so a recurrence alerts again. This monitor is read-only with respect to the chain and does not hold the shared trading lock.

## Funding gate

1. Confirm the registered wallet has at least 1,000 TST and at least 0.001 ETH.
2. Confirm the DoraHacks registration and wallet address still match.
3. Run `npm run readiness`; signer, API, gas, funding, evidence, and ledger must pass.
4. Independently review the assessment, source hashes, quote, size, and target outcome.

## Canary gate

1. Set `DELPHI_LIVE_ENABLED=true` and the exact `DELPHI_LIVE_CONFIRMATION` in the protected VPS environment.
2. Create `/var/lib/delphi-arena/canary-approved.json` only after explicit operator approval.
3. Run one cycle manually. The canary cannot spend more than 1 TST.
4. Verify the transaction, resulting position, quote bounds, ledger record, and leaderboard recognition.
5. The runtime writes `canary-complete.json` and blocks all additional entries.

The static `delphi-cycle.service` may be installed in advance, but `delphi-cycle.timer` must remain disabled through the canary. The settlement timer must also remain disabled until a confirmed position exists.

## Full-live gate

Create `/var/lib/delphi-arena/full-live-approved.json` only after a separate approval following canary verification. Enable the trading timer only after that file exists. Never add a trade solely to satisfy an unpublished activity threshold.

## Recovery

If `trade-ledger.json` contains a `PREPARED` record, do not delete it. Reconcile the wallet transaction history and position state first. Confirm the record only with the actual transaction hash, or leave automation blocked while investigating.
