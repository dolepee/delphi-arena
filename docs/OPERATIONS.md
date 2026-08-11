# Operations

## Current state

The VPS observer is read-only. It snapshots markets and balances, probes official sources, and alerts once when organizer TST funding appears. Trading is not enabled by deployment.

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
