# Delphi Conviction

Source-first prediction-market agent for the Delphi Agent Arena competition.

Registered wallet: `0x86bE235Bb9Aa6D9E2Cf89b2f4E9c90e1ecb7C781`

## Safety contract

- Competition network and registered signer are checked on every command.
- An actionable assessment must be fresh, unexpired, and include an authoritative source hash.
- A forecast must retain at least 8 percentage points of net edge after quoted LMSR impact and fees.
- A decisive official schedule must retain at least 4 percentage points and must expose both the named event and a machine-readable date after the contract deadline.
- An exact result already published by the organizer-named source must retain at least 2 percentage points; forecasts cannot use this tighter floor.
- Market, portfolio, order, slippage, and price-impact caps are enforced before signing.
- Full-live orders below 5 TST are refused to prevent repeated fee-wasting residual fills.
- A prepared intent is written before the approval or buy transaction. Any uncertain write blocks further writes.
- Runtime starts write-disabled. Canary mode additionally requires the exact live confirmation and an operator-created approval file.
- The first canary is capped at 1 TST and automatically blocks further entries until full-live approval exists.
- No fallback or minimum-activity trade is permitted.

## Commands

```bash
npm run typecheck
npm test
npm run snapshot
npm run sources
npm run readiness
npm run preview
npm run monitor
```

`npm run cycle` and `npm run settle` are write-capable. Production activation requires the completed canary and full-live approval records described in `docs/OPERATIONS.md`.
