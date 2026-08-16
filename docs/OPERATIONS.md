# Operations

## Current state

The funded canary and leaderboard-recognition checks completed on August 12. Full-live trading and settlement are active on the VPS under systemd timers. The runtime still requires the protected live confirmation plus the canary and full-live approval records on every write path.

The authoritative-result lane runs through `delphi-event.timer` every 15 seconds. It persists only high-confidence `published_result` assessments at probability `0.99`, quotes any mandatory opposing-position exit, and proves that the event remains executable with the resulting conservative proceeds before it serializes exit and entry through the shared write lock. Contrary exact evidence may still close a losing opposing position when no new entry is economical. Stale entry evidence may release a converged profitable position only inside a prequalified executable event cycle; ordinary position management still requires fresh evidence. It performs no write when no exact result exists. Install and enable both `delphi-event.service` and `delphi-event.timer` together; `OnBootSec=10s` ensures the lane starts after a fresh boot. New deployments must start with `DELPHI_EVENT_EXECUTION_ENABLED=false`; observe a production dry run and verify wallet, source semantics, latency, locks, and ledger state before setting it to `true`.

`delphi-opportunities.timer` compares every open listing with `config/opportunities.json` once per minute. An unknown market is not eligible for execution: the watcher alerts Telegram, records it in private runtime state, and leaves it unclassified until its trading close, decisive-fact timing, source, capacity, and outcome mapping are reviewed.

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
