import { client, assertSignerIdentity } from "../delphi.js";
import { readBook } from "../runtime.js";

const sharesToRaw = (shares: number) => BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;
const rawToTokens = (raw: bigint) => Number(raw) / 1e6;

await assertSignerIdentity();
const book = await readBook(client);
const quotes = [];

for (const position of book.positions) {
  const market = book.markets.find((candidate) =>
    candidate.id.toLowerCase() === position.marketId.toLowerCase()
  );
  if (!market || market.status !== "open") {
    quotes.push({
      marketId: position.marketId,
      outcomeIndex: position.outcomeIndex,
      shares: position.shares,
      status: market?.status ?? "missing",
      sellable: false,
    });
    continue;
  }

  const quote = await client.quoteSell({
    marketAddress: market.id,
    outcomeIdx: position.outcomeIndex,
    sharesIn: sharesToRaw(position.shares),
  });
  const quotedProceedsTst = rawToTokens(quote.tokensOut);
  quotes.push({
    marketId: position.marketId,
    question: market.question,
    outcome: market.outcomes[position.outcomeIndex],
    shares: position.shares,
    status: market.status,
    sellable: true,
    markPrice: position.markPrice,
    markValueTst: position.shares * position.markPrice,
    quotedProceedsTst,
    averageExitPrice: quotedProceedsTst / position.shares,
  });
}

process.stdout.write(`${JSON.stringify({
  observedAt: new Date().toISOString(),
  availableTst: book.availableTst,
  quotes,
}, null, 2)}\n`);
