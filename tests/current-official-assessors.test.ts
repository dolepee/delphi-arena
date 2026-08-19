import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketView } from "../src/model.js";
import { loadOpportunities } from "../src/opportunity-audit.js";
import {
  assessGeminiProRelease,
  assessUapRecordsRelease,
  generateOfficialAssessments,
} from "../src/official-assessors.js";

afterEach(() => vi.unstubAllGlobals());

const GEMINI_MARKET: MarketView = {
  id: "0x2e0d3ee960783033bb70e5b5577a04a1d19f7dcf",
  question: "Will Google release a model called Gemini 3.5 Pro or later by 03:59 UTC on Aug 21, 2026?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-21T03:59:00.000Z",
  prices: [0.3, 0.7],
  tradingFeePct: 0.5,
  dataSources: [],
};

const UAP_MARKET: MarketView = {
  id: "0x2258cfca1af0eac76dcc6d0b1a134f274bdf2d3e",
  question: "Will AARO or ODNI publicly release previously unreleased UAP records between Aug 10 00:00 and Aug 21 14:00 UTC 2026?",
  outcomes: ["Yes", "No"],
  status: "open",
  resolvesAt: "2026-08-21T14:00:00.000Z",
  prices: [0.25, 0.75],
  tradingFeePct: 0.5,
  dataSources: [],
};

const GEMINI_NOW = Date.parse("2026-08-20T16:10:00.000Z");
const UAP_NOW = Date.parse("2026-08-19T14:00:00.000Z");

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function validPdfResponse(): Response {
  return new Response("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });
}

function responseAt(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

describe("Gemini 3.5-or-later Pro exact-result assessment", () => {
  it("accepts a timestamped official 3.5 Pro preview release", async () => {
    const body = await fixture("gemini-35-pro-preview.html");
    const assessment = assessGeminiProRelease({
      market: GEMINI_MARKET,
      body,
      sourceUrl: "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5-pro/",
      sourceObservedAt: GEMINI_NOW,
      now: GEMINI_NOW,
    });
    expect(assessment).toMatchObject({
      marketId: GEMINI_MARKET.id,
      outcomeIndex: 0,
      evidenceClass: "published_result",
      probability: 0.99,
      confidence: "high",
      status: "actionable",
    });
    expect(assessment?.sources[0]?.observedAt).toBe("2026-08-20T16:10:00.000Z");
    expect(assessment?.sources[0]?.valueHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects coming-soon copy, Flash tiers, old Pro versions, and ambiguous Pro names", async () => {
    const comingSoon = await fixture("gemini-35-pro-coming-soon.html");
    const documents = [
      comingSoon,
      comingSoon.replace("Gemini 3.5 Pro is coming soon", "Gemini 3.5 Flash-Lite is available today"),
      comingSoon.replace("Gemini 3.5 Pro is coming soon", "Gemini 3.1 Pro is now available"),
      comingSoon.replace("Gemini 3.5 Pro is coming soon", "Our new Gemini Pro is now available"),
    ];
    for (const body of documents) {
      expect(assessGeminiProRelease({
        market: GEMINI_MARKET,
        body,
        sourceUrl: "https://deepmind.google/blog/gemini-model-update/",
        sourceObservedAt: GEMINI_NOW,
        now: GEMINI_NOW,
      })).toBeNull();
    }
    const bareAnnouncement = '<article><time datetime="2026-08-20T12:00:00.000Z"></time><p>Google announced Gemini 3.5 Pro and published new benchmark results.</p></article>';
    expect(assessGeminiProRelease({
      market: GEMINI_MARKET,
      body: bareAnnouncement,
      sourceUrl: "https://deepmind.google/blog/gemini-model-update/",
      sourceObservedAt: GEMINI_NOW,
      now: GEMINI_NOW,
    })).toBeNull();
    const futureLaunch = '<article><time datetime="2026-08-20T12:00:00.000Z"></time><p>Gemini 3.5 Pro is launching next week.</p></article>';
    expect(assessGeminiProRelease({
      market: GEMINI_MARKET,
      body: futureLaunch,
      sourceUrl: "https://deepmind.google/blog/gemini-model-update/",
      sourceObservedAt: GEMINI_NOW,
      now: GEMINI_NOW,
    })).toBeNull();
  });

  it("rejects negated and modal release or availability claims", () => {
    const claims = [
      "Gemini 3.5 Pro has not been released.",
      "Gemini 3.5 Pro is not available.",
      "Gemini 3.5 Pro availability has not been announced.",
      "Gemini 3.5 Pro will not be released.",
      "Gemini 3.5 Pro can never be launched.",
      "Gemini 3.5 Pro cannot be rolled out.",
      "Gemini 3.5 Pro may not become available.",
      "Gemini 3.5 Pro might be released.",
      "Gemini 3.5 Pro will be available tomorrow.",
      "Is Gemini 3.5 Pro available? Not yet.",
      "When will Gemini 3.5 Pro be available? We have no date.",
      "Availability of Gemini 3.5 Pro has not been announced.",
      "We expect Gemini 3.5 Pro to be released later.",
      "Gemini 3.5 Pro is slated to launch today.",
      "Google is evaluating whether to release Gemini 3.5 Pro.",
      "Gemini 3.5 Pro remains a candidate for release.",
      "Gemini 3.5 Pro is available only on the roadmap.",
      "Gemini 3.5 Pro is available to employees only.",
      "Gemini 3.5 Pro is available in name only.",
      "Gemini 3.5 Pro is available for reference only.",
    ];
    for (const claim of claims) {
      const body = `<article><time datetime="2026-08-20T12:00:00.000Z"></time><p>${claim}</p></article>`;
      expect(assessGeminiProRelease({
        market: GEMINI_MARKET,
        body,
        sourceUrl: "https://deepmind.google/blog/gemini-model-update/",
        sourceObservedAt: GEMINI_NOW,
        now: GEMINI_NOW,
      }), claim).toBeNull();
    }
  });

  it("keeps negation scoped to its own official entry", () => {
    const body = `
      <article><time datetime="2026-08-20T11:00:00.000Z"></time><p>Gemini 3.5 Pro has not been released.</p></article>
      <article><time datetime="2026-08-20T12:00:00.000Z"></time><p>Gemini 3.5 Pro is now available in preview.</p></article>`;
    expect(assessGeminiProRelease({
      market: GEMINI_MARKET,
      body,
      sourceUrl: "https://deepmind.google/blog/gemini-model-update/",
      sourceObservedAt: GEMINI_NOW,
      now: GEMINI_NOW,
    })?.outcomeIndex).toBe(0);
  });

  it("does not join an at-close Pro article to an earlier Flash article", () => {
    const body = `
      <article><time datetime="2026-08-21T03:59:00.000Z"></time><p>Gemini 3.5 Pro is now available.</p></article>
      <article><time datetime="2026-08-20T12:00:00.000Z"></time><p>Gemini 3.5 Flash-Lite is now available.</p></article>`;
    expect(assessGeminiProRelease({
      market: GEMINI_MARKET,
      body,
      sourceUrl: "https://deepmind.google/blog/gemini-model-update/",
      sourceObservedAt: GEMINI_NOW,
      now: GEMINI_NOW,
    })).toBeNull();
  });

  it("rejects at-close, future, non-official, and stale evidence", async () => {
    const valid = await fixture("gemini-35-pro-preview.html");
    const conflictingTimes = valid
      .replace("2026-08-20T16:05:00.000Z", "2026-08-21T03:59:00.000Z")
      .replace("<h1>", '<time datetime="2026-08-20T12:00:00.000Z"></time><h1>');
    const cases = [
      { body: valid.replace("2026-08-20T16:05:00.000Z", "2026-08-21T03:59:00.000Z") },
      { body: valid.replace("2026-08-20T16:05:00.000Z", "2026-08-20T17:00:00.000Z") },
      { body: conflictingTimes },
      { body: valid, sourceUrl: "https://example.com/gemini-3-5-pro" },
      { body: valid, sourceObservedAt: GEMINI_NOW - 15 * 60_000 - 1 },
    ];
    for (const item of cases) {
      expect(assessGeminiProRelease({
        market: GEMINI_MARKET,
        sourceUrl: "https://deepmind.google/blog/gemini-3-5-pro/",
        sourceObservedAt: GEMINI_NOW,
        now: GEMINI_NOW,
        ...item,
      })).toBeNull();
    }
  });

  it("accepts an undated model-catalog flip only against the frozen negative baseline", () => {
    const assessment = assessGeminiProRelease({
      market: GEMINI_MARKET,
      body: "<main><h2>Gemini 3.5 Pro</h2><p>Gemini 3.5 Pro is now available in limited access to developers.</p></main>",
      sourceUrl: "https://deepmind.google/models/gemini/",
      sourceObservedAt: GEMINI_NOW,
      now: GEMINI_NOW,
    });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.sources).toHaveLength(2);
    expect(assessment?.sources[1]).toMatchObject({
      url: "https://deepmind.google/models/gemini/",
      observedAt: "2026-08-19T15:45:45.000Z",
      valueHash: "598e1f22f912713a90118c4b5635ab34c98b8cbe37853b871547dfe47e678523",
    });
    expect(assessGeminiProRelease({
      market: GEMINI_MARKET,
      body: "<main><p>Gemini 3.5 Pro is now available.</p></main>",
      sourceUrl: "https://deepmind.google/blog/undated-gemini-update/",
      sourceObservedAt: GEMINI_NOW,
      now: GEMINI_NOW,
    })).toBeNull();
  });

  it("discovers and evaluates a linked official release page", async () => {
    const released = await fixture("gemini-35-pro-preview.html");
    vi.stubGlobal("fetch", vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url === "https://blog.google/technology/google-deepmind/") {
        return new Response('<article><a href="https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5-pro/">Gemini 3.5 Pro</a></article>');
      }
      if (url === "https://deepmind.google/models/gemini/") return new Response("<main>Gemini models</main>");
      if (url.endsWith("/gemini-3-5-pro/")) return new Response(released);
      return new Response("missing", { status: 404 });
    }));
    const assessments = await generateOfficialAssessments([GEMINI_MARKET], GEMINI_NOW);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]?.outcomeIndex).toBe(0);
  });

  it("follows the model page's real unquoted teaser link and rejects it", async () => {
    const modelPage = await fixture("gemini-models-current-teaser.html");
    const teaser = await fixture("gemini-35-pro-coming-soon.html");
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url === "https://blog.google/technology/google-deepmind/") return new Response("<main>Google DeepMind news</main>");
      if (url === "https://deepmind.google/models/gemini/") return new Response(modelPage);
      if (url === "https://deepmind.google/blog/gemini-3-5-frontier-intelligence-with-action/") return new Response(teaser);
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await generateOfficialAssessments([GEMINI_MARKET], GEMINI_NOW)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://deepmind.google/blog/gemini-3-5-frontier-intelligence-with-action/",
      expect.any(Object),
    );
  });
});

describe("AARO/ODNI new-UAP-record exact-result assessment", () => {
  it("accepts a timestamped, newly released artifact on AARO", async () => {
    const body = await fixture("aaro-new-uap-records.html");
    vi.stubGlobal("fetch", vi.fn(async () => validPdfResponse()));
    const assessment = await assessUapRecordsRelease({
      market: UAP_MARKET,
      body,
      sourceUrl: "https://www.aaro.mil/Resources/Cases-Reports/",
      sourceObservedAt: UAP_NOW,
      now: UAP_NOW,
    });
    expect(assessment).toMatchObject({
      marketId: UAP_MARKET.id,
      outcomeIndex: 0,
      evidenceClass: "published_result",
      probability: 0.99,
      confidence: "high",
    });
    expect(assessment?.sources.at(-1)).toMatchObject({
      url: "https://www.aaro.mil/Portals/136/PDFs/UAP_RECORDS/mission-record-2026-08-19.pdf",
      kind: "authoritative",
    });
    expect(assessment?.sources.at(-1)?.valueHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects republished records and press material without a new record artifact", async () => {
    const republished = await fixture("aaro-republished-uap-records.html");
    const pressOnly = '<article><time datetime="2026-08-19T13:20:00.000Z"></time><p>ODNI held a new UAP press briefing and released a news statement.</p></article>';
    for (const [body, sourceUrl] of [
      [republished, "https://www.aaro.mil/Resources/Cases-Reports/"],
      [pressOnly, "https://www.dni.gov/index.php/newsroom/reports-publications"],
    ] as const) {
      expect(await assessUapRecordsRelease({ market: UAP_MARKET, body, sourceUrl, sourceObservedAt: UAP_NOW, now: UAP_NOW })).toBeNull();
    }
  });

  it("does not join an old artifact entry to a new press entry", async () => {
    const body = `
      <article><time datetime="2026-08-09T20:00:00.000Z"></time><p>AARO released new UAP records.</p><a href="/Portals/136/old-uap-record.pdf">record</a></article>
      <article><time datetime="2026-08-19T13:00:00.000Z"></time><p>AARO held a new UAP press briefing.</p></article>`;
    expect(await assessUapRecordsRelease({
      market: UAP_MARKET,
      body,
      sourceUrl: "https://www.aaro.mil/Resources/Cases-Reports/",
      sourceObservedAt: UAP_NOW,
      now: UAP_NOW,
    })).toBeNull();
  });

  it("rejects other-agency, old, at-close, future, and stale evidence", async () => {
    const valid = await fixture("aaro-new-uap-records.html");
    const cases = [
      { body: valid, sourceUrl: "https://www.defense.gov/uap-records/" },
      { body: valid.replace("2026-08-19T13:20:00.000Z", "2026-08-09T23:59:59.000Z") },
      { body: valid.replace("2026-08-19T13:20:00.000Z", "2026-08-21T14:00:00.000Z") },
      { body: valid.replace("2026-08-19T13:20:00.000Z", "2026-08-20T14:00:00.000Z") },
      { body: valid, sourceObservedAt: UAP_NOW - 15 * 60_000 - 1 },
    ];
    for (const item of cases) {
      expect(await assessUapRecordsRelease({
        market: UAP_MARKET,
        sourceUrl: "https://www.aaro.mil/Resources/Cases-Reports/",
        sourceObservedAt: UAP_NOW,
        now: UAP_NOW,
        ...item,
      })).toBeNull();
    }
  });

  it("rejects negated and modal UAP release claims without touching the artifact", async () => {
    const fetchMock = vi.fn(async () => validPdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    const claims = [
      "AARO did not release new UAP records.",
      "AARO has not released new UAP records.",
      "AARO cannot release new UAP records.",
      "AARO never published newly disclosed UAP records.",
      "AARO may not publish newly disclosed UAP records.",
      "AARO might release new UAP records.",
      "AARO will release new UAP records tomorrow.",
      "AARO did not release new UAP records and published a routine status report.",
      "Did AARO release new UAP records?",
      "AARO denies it released new UAP records.",
      "AARO disputes claims that it released new UAP records.",
      "AARO expects to release new UAP records later.",
      "AARO reportedly released new UAP records.",
      "AARO discussed possible declassification of new UAP records.",
      "AARO guidance explains declassification procedures for UAP records.",
      "AARO did not release new UAP records and ODNI published newly disclosed budget documents.",
      "AARO released a new UAP records policy.",
      "AARO published a new UAP records FAQ.",
      "AARO posted a new UAP records index.",
      "AARO released a new UAP report summary.",
      "AARO released a new UAP records request form.",
      "New Content New UAP Records FAQ.",
    ];
    for (const claim of claims) {
      const body = `<article><time datetime="2026-08-19T13:20:00.000Z"></time><p>${claim}</p><a href="/Portals/136/PDFs/UAP_RECORDS/claim.pdf">record</a></article>`;
      expect(await assessUapRecordsRelease({
        market: UAP_MARKET,
        body,
        sourceUrl: "https://www.aaro.mil/Resources/Cases-Reports/",
        sourceObservedAt: UAP_NOW,
        now: UAP_NOW,
      }), claim).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a negated entry from suppressing a separate positive entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => validPdfResponse()));
    const body = `
      <article><time datetime="2026-08-19T12:00:00.000Z"></time><p>AARO did not release new UAP records.</p><a href="/Portals/136/PDFs/UAP_RECORDS/negative.pdf">record</a></article>
      <article><time datetime="2026-08-19T13:20:00.000Z"></time><p>AARO released previously unreleased UAP records.</p><a href="/Portals/136/PDFs/UAP_RECORDS/positive.pdf">record</a></article>`;
    const assessment = await assessUapRecordsRelease({
      market: UAP_MARKET,
      body,
      sourceUrl: "https://www.aaro.mil/Resources/Cases-Reports/",
      sourceObservedAt: UAP_NOW,
      now: UAP_NOW,
    });
    expect(assessment?.outcomeIndex).toBe(0);
    expect(assessment?.sources.at(-1)?.url).toBe("https://www.aaro.mil/Portals/136/PDFs/UAP_RECORDS/positive.pdf");
  });

  it("rejects missing, empty, wrong-type, and off-origin artifact responses", async () => {
    const body = await fixture("aaro-new-uap-records.html");
    const responses = [
      new Response("missing", { status: 404 }),
      new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/pdf" } }),
      new Response("%PDF-1.7\n", { status: 200, headers: { "content-type": "text/html" } }),
      responseAt(validPdfResponse(), "https://example.com/redirected-record.pdf"),
    ];
    for (const response of responses) {
      vi.stubGlobal("fetch", vi.fn(async () => response));
      expect(await assessUapRecordsRelease({
        market: UAP_MARKET,
        body,
        sourceUrl: "https://www.aaro.mil/Resources/Cases-Reports/",
        sourceObservedAt: UAP_NOW,
        now: UAP_NOW,
      })).toBeNull();
    }
  });

  it("requires the organizer-named AARO seed and preserves the DNI-to-ODNI redirect chain", async () => {
    const body = await fixture("aaro-new-uap-records.html");
    expect(await assessUapRecordsRelease({
      market: UAP_MARKET,
      body,
      sourceUrl: "https://www.aaro.mil/UAP-Records/",
      sourceObservedAt: UAP_NOW,
      now: UAP_NOW,
    })).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => validPdfResponse()));
    expect((await assessUapRecordsRelease({
      market: UAP_MARKET,
      body: body.replace("/Portals/136/PDFs/UAP_RECORDS/mission-record-2026-08-19.pdf", "/files/ODNI/documents/uap-record-2026-08-19.pdf"),
      sourceUrl: "https://www.odni.gov/newsroom/",
      sourceRequestedUrl: "https://www.dni.gov/index.php/newsroom/reports-publications",
      sourceRootUrl: "https://www.dni.gov/index.php/newsroom/reports-publications",
      sourceRootHash: "a".repeat(64),
      sourceObservedAt: UAP_NOW,
      now: UAP_NOW,
    }))?.outcomeIndex).toBe(0);
    expect(await assessUapRecordsRelease({
      market: UAP_MARKET,
      body,
      sourceUrl: "https://www.odni.gov/newsroom/",
      sourceObservedAt: UAP_NOW,
      now: UAP_NOW,
    })).toBeNull();
  });

  it("follows an AARO record page only from the organizer-named root", async () => {
    const released = await fixture("aaro-uap-records-new-row.html");
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url === "https://www.aaro.mil/Resources/Cases-Reports/") {
        return new Response('<main><a href="https://www.aaro.mil/UAP-Records/">UAP Records</a></main>');
      }
      if (url === "https://www.aaro.mil/UAP-Records/") return new Response(released);
      if (url.endsWith("/newly-unredacted-uap-case-record.pdf")) return validPdfResponse();
      return new Response("denied", { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const assessments = await generateOfficialAssessments([UAP_MARKET], UAP_NOW);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]?.outcomeIndex).toBe(0);
    expect(assessments[0]?.sources.map((source) => source.url)).toEqual([
      "https://www.aaro.mil/UAP-Records/",
      "https://www.aaro.mil/Resources/Cases-Reports/",
      "https://www.aaro.mil/Portals/136/PDFs/UAP_RECORDS/newly-unredacted-uap-case-record.pdf",
    ]);
    expect(fetchMock).toHaveBeenCalledWith("https://www.aaro.mil/UAP-Records/", expect.any(Object));
  });
});

describe("the eight live-market classifications", () => {
  it("maps only Gemini YES and UAP YES as pre-close result-capable", async () => {
    const definitions = await loadOpportunities(resolve("config/opportunities.json"));
    const expected = new Map<string, { classification: string; outcomes: number[] }>([
      ["0xbf1ce7c9d751b92bfac4acefe0e87d82b1d30163", { classification: "forecast_only", outcomes: [] }],
      ["0xc598c6fac139b5b76a88ac08bf3e4663f1336acc", { classification: "forecast_only", outcomes: [] }],
      ["0x360274d153c58566943cb21088dd95e45638bda3", { classification: "forecast_only", outcomes: [] }],
      ["0x26c97689a636c28040e979f1d242fd996730a8bc", { classification: "forecast_only", outcomes: [] }],
      ["0x701f91b48fdf8eaac09de1317f34d3d901b74216", { classification: "forecast_only", outcomes: [] }],
      ["0x2e0d3ee960783033bb70e5b5577a04a1d19f7dcf", { classification: "partial_result", outcomes: [0] }],
      ["0x2258cfca1af0eac76dcc6d0b1a134f274bdf2d3e", { classification: "partial_result", outcomes: [0] }],
      ["0x77985bbb52a7744a8eeab5a82d02c8c079fa7a55", { classification: "forecast_only", outcomes: [] }],
    ]);
    for (const [marketId, mapping] of expected) {
      const definition = definitions.find((item) => item.marketId === marketId);
      expect(definition?.classification, marketId).toBe(mapping.classification);
      expect(definition?.resultCapableOutcomes, marketId).toEqual(mapping.outcomes);
      expect(definition?.earliestDecisiveAt, marketId).toBeTruthy();
    }
  });
});
