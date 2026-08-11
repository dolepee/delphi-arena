# Delphi Conviction

Source-first prediction-market agent for the Delphi Agent Arena competition.

Registered wallet: `0x86bE235Bb9Aa6D9E2Cf89b2f4E9c90e1ecb7C781`

## Safety contract

- Competition network and registered signer are checked on every command.
- An actionable assessment must be fresh, unexpired, and include an authoritative source hash.
- A trade must retain at least 8 percentage points of net edge after quoted LMSR impact and fees.
- Market, portfolio, order, slippage, and price-impact caps are enforced before signing.
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

`npm run cycle` and `npm run settle` are write-capable and must remain disabled until the funded canary procedure in `docs/OPERATIONS.md` is complete.
