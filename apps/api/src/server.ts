import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Fastify from "fastify";

import {
  predictBandOpenings,
  buildOpportunitySnapshotWithDebug,
  detectDxEvents,
  findNearbyOpportunities,
  getDirectionalPropagation,
  loadDxRarityContext,
  getAllBandTrends,
  parseMaidenheadLocator,
  parseStoredOpportunitySpot,
  summarizeStoredSpotBandResolution,
  type PskBandTrendMap,
  type PskReporterSummary,
  type SolarConditions,
  type OpportunitySnapshot,
} from "@radio-pilot/shared";
import { createClient } from "redis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

const RECENT_WINDOW_MS = 15 * 60 * 1000;
const FILTER_CACHE_REFRESH_MS = 5_000;
const FILTER_CACHE_MAX_STALE_MS = 30_000;
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";
// Local development should use the public Railway Redis URL from the repo root .env.
// Railway deployments should set REDIS_URL to the Redis private endpoint in Railway service variables.
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const app = Fastify({ logger: false });
const redis = createClient({ url: redisUrl });

interface CachedOpportunityInputs {
  readonly now: number;
  readonly rawSpots: readonly string[];
  readonly spots: ReturnType<typeof parseStoredOpportunitySpot>[number][];
  readonly solar: SolarConditions | null;
  readonly pskSummary: PskReporterSummary | null;
  readonly pskTrends: PskBandTrendMap;
  readonly bandPredictions: Awaited<ReturnType<typeof predictBandOpenings>>;
  readonly propagationDensity: Awaited<ReturnType<typeof getDirectionalPropagation>>;
  readonly dxRarity: Awaited<ReturnType<typeof loadDxRarityContext>>;
  readonly dxEvents: Awaited<ReturnType<typeof detectDxEvents>>;
  readonly bandResolution: ReturnType<typeof summarizeStoredSpotBandResolution>;
}

let cachedOpportunityInputs:
  | {
      readonly expiresAt: number;
      readonly value: CachedOpportunityInputs;
    }
  | null = null;
let cachedOpportunityInputsPending: Promise<CachedOpportunityInputs> | null = null;

const emptySnapshot = (): OpportunitySnapshot => ({
  generatedAt: new Date(0).toISOString(),
  cards: [],
  bestOpportunity: null,
  watchNext: [],
  dxOpportunity: null,
  nearbyActivity: [],
  solar: null,
});

await redis.connect();

app.addHook("onRequest", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", "http://localhost:5173");
  reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    reply.code(204).send();
  }
});

app.get("/", async (_request, reply) => {
  reply.type("text/html; charset=utf-8");
  return renderIndexPage();
});

app.get("/health", async () => {
  const [dxclusterLastSeen, rawSnapshot] = await Promise.all([
    redis.get("freshness:dxcluster"),
    redis.get("snapshot:default"),
  ]);

  const snapshotGeneratedAt = parseSnapshot(rawSnapshot)?.generatedAt ?? null;

  return {
    status: dxclusterLastSeen ? "ok" : "starting",
    dxclusterLastSeen,
    snapshotGeneratedAt,
  };
});

app.get("/api/opportunities", async (request) => {
  return buildPersonalizedSnapshot(request.query, "api");
});

app.get("/debug/recent-spots", async () => {
  const values = await redis.zRange("spots:recent", 0, 19, { REV: true });
  return values.map((value) => parseJson(value) ?? value);
});

app.get("/debug/snapshot", async (request) => {
  return buildPersonalizedSnapshot(request.query, "debug");
});

app.get("/debug/opportunities", async (request) => {
  return buildPersonalizedSnapshotDebug(request.query);
});

app.get("/debug/dx", async (request) => {
  const built = await buildPersonalizedSnapshotDebug(request.query, "debug-opportunities");
  return {
    dxCandidates: built.dxCandidates,
  };
});

app.get("/debug/solar", async () => {
  const rawSolar = await redis.get("solar:latest");
  return parseSolar(rawSolar);
});

app.get("/debug/psk", async () => {
  const [rawSummary, freshness, rawMetrics] = await Promise.all([
    redis.get("psk:summary"),
    redis.get("psk:freshness"),
    redis.get("psk:metrics"),
  ]);
  const summary = parseJson(rawSummary ?? "");
  const metrics = parsePskMetrics(rawMetrics);
  const lastRedisWriteSecondsAgo = getSecondsAgo(freshness);
  const trends = await getAllBandTrends(redis);

  return {
    mqttConnected: metrics?.mqttConnected ?? false,
    parserHealthy: metrics?.parserHealthy ?? true,
    messagesReceived: metrics?.messagesReceived ?? 0,
    reportsParsed: metrics?.reportsParsed ?? 0,
    reportsRetained: metrics?.reportsRetained ?? 0,
    malformedMessages: metrics?.malformedMessages ?? 0,
    droppedReports: metrics?.droppedReports ?? {},
    lastReportSecondsAgo: metrics?.lastReportSecondsAgo ?? null,
    messagesLast10s: metrics?.messagesLast10s ?? 0,
    bandsActive: getActivePskBands(summary),
    directionsActive: getActivePskDirections(summary),
    lastRedisWriteSecondsAgo,
    summary: summary ?? {},
    freshness,
    trends,
  };
});

app.get("/debug/nearby", async (request) => {
  const homeGrid = getHomeGridFromQuery(request.query);

  if (!homeGrid) {
    return {
      candidates: [],
      message: "Valid homeGrid query parameter required",
    };
  }

  const now = Date.now();
  const rawSpots = await redis.zRangeByScore("spots:recent", now - RECENT_WINDOW_MS, now);
  const spots = rawSpots.flatMap(parseStoredOpportunitySpot);
  const nearby = findNearbyOpportunities({ homeGrid }, spots, undefined, now);

  return {
    candidates: nearby.candidates,
  };
});

app.get("/debug/bands", async (_request) => {
  return {
    bands: await predictBandOpenings(redis, {}),
  };
});

app.get("/debug/propagation", async (request) => {
  const homeGrid = getHomeGridFromQuery(request.query);
  const propagation = await getDirectionalPropagation(redis, { homeGrid });
  return formatPropagationDebugResponse(propagation);
});

await app.listen({ port, host });

function parseSnapshot(value: string | null): OpportunitySnapshot | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as OpportunitySnapshot;
  } catch {
    return null;
  }
}

function parseSolar(value: string | null): SolarConditions | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SolarConditions>;

    if (
      typeof parsed.updatedAt === "string"
    ) {
      return {
        sfi: typeof parsed.sfi === "number" ? parsed.sfi : undefined,
        kp: typeof parsed.kp === "number" ? parsed.kp : undefined,
        aIndex: typeof parsed.aIndex === "number" ? parsed.aIndex : undefined,
        muf:
          typeof parsed.muf === "number" || typeof parsed.muf === "string"
            ? parsed.muf
            : undefined,
        sunspots: typeof parsed.sunspots === "number" ? parsed.sunspots : undefined,
        updatedAt: parsed.updatedAt,
        ...deriveSolarGuidance({
          sfi: typeof parsed.sfi === "number" ? parsed.sfi : undefined,
          kp: typeof parsed.kp === "number" ? parsed.kp : undefined,
          aIndex: typeof parsed.aIndex === "number" ? parsed.aIndex : undefined,
          muf:
            typeof parsed.muf === "number" || typeof parsed.muf === "string"
              ? parsed.muf
              : undefined,
          sunspots: typeof parsed.sunspots === "number" ? parsed.sunspots : undefined,
          updatedAt: parsed.updatedAt,
        }),
      };
    }
  } catch {
    return null;
  }

  return null;
}

function parsePskSummary(value: string | null): PskReporterSummary | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as PskReporterSummary;
    return Array.isArray(parsed.bands) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePskMetrics(value: string | null): {
  mqttConnected: boolean;
  parserHealthy: boolean;
  messagesReceived: number;
  reportsParsed: number;
  reportsRetained: number;
  malformedMessages: number;
  droppedReports: Record<string, number>;
  lastReportSecondsAgo: number | null;
  messagesLast10s: number;
  updatedAt: string;
} | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<{
      mqttConnected: boolean;
      parserHealthy: boolean;
      messagesReceived: number;
      reportsParsed: number;
      reportsRetained: number;
      malformedMessages: number;
      droppedReports: Record<string, number>;
      lastReportSecondsAgo: number | null;
      messagesLast10s: number;
      updatedAt: string;
    }>;

    if (
      typeof parsed.mqttConnected === "boolean" &&
      typeof parsed.parserHealthy === "boolean" &&
      typeof parsed.messagesReceived === "number" &&
      typeof parsed.reportsParsed === "number" &&
      typeof parsed.reportsRetained === "number" &&
      typeof parsed.malformedMessages === "number" &&
      typeof parsed.droppedReports === "object" &&
      parsed.droppedReports !== null &&
      (typeof parsed.lastReportSecondsAgo === "number" || parsed.lastReportSecondsAgo === null) &&
      typeof parsed.messagesLast10s === "number" &&
      typeof parsed.updatedAt === "string"
    ) {
      return {
        mqttConnected: parsed.mqttConnected,
        parserHealthy: parsed.parserHealthy,
        messagesReceived: parsed.messagesReceived,
        reportsParsed: parsed.reportsParsed,
        reportsRetained: parsed.reportsRetained,
        malformedMessages: parsed.malformedMessages,
        droppedReports: parsed.droppedReports,
        lastReportSecondsAgo: parsed.lastReportSecondsAgo,
        messagesLast10s: parsed.messagesLast10s,
        updatedAt: parsed.updatedAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function getHomeGridFromQuery(query: unknown): string | undefined {
  if (!query || typeof query !== "object") {
    return undefined;
  }

  const homeGrid = Reflect.get(query, "homeGrid");

  if (typeof homeGrid !== "string") {
    return undefined;
  }

  const normalized = homeGrid.trim().toUpperCase();
  return parseMaidenheadLocator(normalized) ? normalized : undefined;
}

function getOperatingStyleFromQuery(query: unknown): string | undefined {
  if (!query || typeof query !== "object") {
    return undefined;
  }

  const operatingStyle = Reflect.get(query, "operatingStyle");

  if (typeof operatingStyle !== "string") {
    return undefined;
  }

  const normalized = operatingStyle.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function getSecondsAgo(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

function getActivePskBands(summary: unknown): string[] {
  if (!summary || typeof summary !== "object") {
    return [];
  }

  if (Array.isArray(Reflect.get(summary, "bands"))) {
    const bands = Reflect.get(summary, "bands") as Array<Record<string, unknown>>;

    return bands
      .filter((band) => typeof band.band === "string" && typeof band.currentWindowCount === "number" && band.currentWindowCount > 0)
      .map((band) => band.band as string);
  }

  return Object.entries(summary as Record<string, unknown>)
    .filter((entry) => typeof entry[1] === "number" && (entry[1] as number) > 0)
    .map(([band]) => band);
}

function getActivePskDirections(summary: unknown): string[] {
  if (!summary || typeof summary !== "object") {
    return [];
  }

  const bands = Reflect.get(summary, "bands");

  if (!Array.isArray(bands)) {
    return [];
  }

  const directions = new Set<string>();

  for (const band of bands) {
    if (!band || typeof band !== "object") {
      continue;
    }

    const directionCounts = Reflect.get(band, "directionCounts");

    if (!directionCounts || typeof directionCounts !== "object") {
      continue;
    }

    for (const [direction, value] of Object.entries(directionCounts as Record<string, unknown>)) {
      if (typeof value === "number" && value > 0) {
        directions.add(direction);
      }
    }
  }

  return [...directions];
}

function formatPropagationDebugResponse(
  propagation: Awaited<ReturnType<typeof getDirectionalPropagation>>,
): Record<string, {
  dominantDirection?: string;
  dominantSector: string | null;
  heading?: number;
  confidence: "High" | "Medium" | "Low";
  densities: Record<string, number>;
}> {
  return Object.fromEntries(
    Object.entries(propagation).map(([band, density]) => [
      band,
      {
        dominantDirection: density.dominantDirection,
        dominantSector: density.sector ?? null,
        heading: density.heading ?? density.beamHeading,
        confidence: density.confidence,
        densities: Object.fromEntries(
          Object.entries(density.densities).map(([direction, value]) => [direction, value ?? 0]),
        ),
      },
    ]),
  );
}

async function buildPersonalizedSnapshot(
  query: unknown,
  source: "api" | "debug",
): Promise<OpportunitySnapshot> {
  return (await buildPersonalizedSnapshotDebug(query, source)).snapshot;
}

async function buildPersonalizedSnapshotDebug(
  query: unknown,
  source: "api" | "debug-opportunities" | "debug" = "debug-opportunities",
): Promise<ReturnType<typeof buildOpportunitySnapshotWithDebug>> {
  const homeGrid = getHomeGridFromQuery(query);
  const operatingStyle = getOperatingStyleFromQuery(query);
  const chasing = getChasingFromQuery(query);
  const modeFilter = getModeFilterFromQuery(query);
  const bandScope = getBandScopeFromQuery(query);
  const baseInputs = await getCachedOpportunityInputs();
  const {
    now,
    rawSpots,
    spots,
    solar,
    pskSummary,
    pskTrends,
    bandPredictions,
    propagationDensity,
    dxRarity,
    dxEvents,
    bandResolution,
  } = baseInputs;

  if (spots.length === 0) {
    const empty = {
      ...emptySnapshot(),
      solar,
    };

    return {
      snapshot: empty,
      bands: [],
      dxCandidates: [],
      bandResolution,
    };
  }

  const built = buildOpportunitySnapshotWithDebug(spots, {
    now,
    homeGrid,
    operatingStyle,
    chasing,
    modeFilter,
    bandScope,
    pskSummary: isFreshPskSummary(pskSummary, now) ? pskSummary : null,
    pskTrends: filterFreshPskTrends(pskTrends, now),
    dxRarity,
    dxEvents,
    solar,
    bandPredictions,
    propagationDensity,
  });
  const snapshot = {
    ...built.snapshot,
    solar,
  };

  return { ...built, snapshot, bandResolution };
}

async function getCachedOpportunityInputs(): Promise<CachedOpportunityInputs> {
  const now = Date.now();

  if (cachedOpportunityInputs) {
    const cacheAgeMs = now - cachedOpportunityInputs.value.now;

    if (cacheAgeMs <= FILTER_CACHE_REFRESH_MS) {
      return cachedOpportunityInputs.value;
    }

    if (cacheAgeMs <= FILTER_CACHE_MAX_STALE_MS) {
      triggerOpportunityInputsRefresh(now);
      return cachedOpportunityInputs.value;
    }
  }

  if (cachedOpportunityInputsPending) {
    return cachedOpportunityInputsPending;
  }

  triggerOpportunityInputsRefresh(now);

  try {
    return await cachedOpportunityInputsPending!;
  } finally {
    cachedOpportunityInputsPending = null;
  }
}

function triggerOpportunityInputsRefresh(now: number): void {
  if (cachedOpportunityInputsPending) {
    return;
  }

  cachedOpportunityInputsPending = loadOpportunityInputs(now)
    .then((value) => {
      cachedOpportunityInputs = {
        value,
        expiresAt: value.now + FILTER_CACHE_MAX_STALE_MS,
      };
      return value;
    })
    .finally(() => {
      cachedOpportunityInputsPending = null;
    });
}

async function loadOpportunityInputs(now: number): Promise<CachedOpportunityInputs> {
  const [rawSpots, rawSolar, rawPsk, pskTrends, bandPredictions, propagationDensity] = await Promise.all([
    redis.zRangeByScore("spots:recent", now - RECENT_WINDOW_MS * 2, now),
    redis.get("solar:latest"),
    redis.get("psk:summary"),
    getAllBandTrends(redis),
    predictBandOpenings(redis, {}),
    getDirectionalPropagation(redis, {}),
  ]);
  const spots = rawSpots.flatMap(parseStoredOpportunitySpot);
  const dxRarity = await loadDxRarityContext(redis, spots, now);
  const dxEvents = await detectDxEvents(spots, redis, now, { rarity: dxRarity });
  const solar = parseSolar(rawSolar);
  const pskSummary = parsePskSummary(rawPsk);

  return {
    now,
    rawSpots,
    spots,
    solar,
    pskSummary,
    pskTrends,
    bandPredictions,
    propagationDensity,
    dxRarity,
    dxEvents,
    bandResolution: summarizeStoredSpotBandResolution(rawSpots),
  };
}

function getChasingFromQuery(
  query: unknown,
): "dx" | "pota" | "sota" | "portable" | "digital" | undefined {
  const chasing = Reflect.get(query as object, "chasing");

  if (typeof chasing !== "string") {
    return undefined;
  }

  const normalized = chasing.trim().toLowerCase();

  if (
    normalized === "dx" ||
    normalized === "pota" ||
    normalized === "sota" ||
    normalized === "portable" ||
    normalized === "digital"
  ) {
    return normalized;
  }

  return undefined;
}

function getModeFilterFromQuery(
  query: unknown,
): "ssb" | "cw" | "digital" | undefined {
  const mode = Reflect.get(query as object, "mode");

  if (typeof mode !== "string") {
    return undefined;
  }

  const normalized = mode.trim().toLowerCase();
  return normalized === "ssb" || normalized === "cw" || normalized === "digital"
    ? normalized
    : undefined;
}

function getBandScopeFromQuery(
  query: unknown,
): "hf" | "vhf-uhf" | undefined {
  const bandScope = Reflect.get(query as object, "bandScope");

  if (typeof bandScope !== "string") {
    return undefined;
  }

  const normalized = bandScope.trim().toLowerCase();
  return normalized === "hf" || normalized === "vhf-uhf" ? normalized : undefined;
}

function isFreshPskSummary(summary: PskReporterSummary | null, now: number): boolean {
  if (!summary) {
    return false;
  }

  const freshness = Date.parse(summary.freshnessTimestamp);
  return Number.isFinite(freshness) && freshness >= now - RECENT_WINDOW_MS * 2;
}

function filterFreshPskTrends(
  trends: PskBandTrendMap,
  _now: number,
): PskBandTrendMap {
  return trends;
}

function deriveSolarGuidance(solar: SolarConditions): Pick<SolarConditions, "favouredBands" | "solarSummary"> {
  const muf = parseSolarMuf(solar.muf);
  const sfi = solar.sfi ?? 0;
  const kp = solar.kp ?? 0;
  const favouredBands: string[] = [];
  const solarSummary: string[] = [];

  if (muf !== null && muf >= 28 && sfi >= 140 && kp <= 3) {
    favouredBands.push("10m");
    solarSummary.push("10m possible");
  } else {
    solarSummary.push("10m unlikely");
  }

  if (muf !== null && muf >= 21 && kp <= 4) {
    favouredBands.push("15m");
    solarSummary.push("15m possible");
  }

  if (muf !== null && muf >= 14) {
    favouredBands.push("20m");
    solarSummary.push("20m reliable");
  }

  if (kp <= 5) {
    favouredBands.push("40m");
    solarSummary.push("40m usable");
  }

  return {
    favouredBands,
    solarSummary,
  };
}

function parseSolarMuf(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function renderIndexPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Radio Pilot</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Georgia, "Times New Roman", serif;
      }

      body {
        margin: 0;
        padding: 32px;
        background: #f4f4f1;
        color: #1f1f1f;
      }

      main {
        max-width: 960px;
        margin: 0 auto;
      }

      h1 {
        margin: 0 0 24px;
        font-size: 2rem;
      }

      p {
        margin: 0 0 24px;
        color: #4b4b4b;
      }

      section {
        margin-bottom: 24px;
        padding: 16px;
        border: 1px solid #d0d0c8;
        background: #ffffff;
      }

      h2 {
        margin: 0 0 12px;
        font-size: 1.2rem;
      }

      .card {
        padding: 12px 0;
        border-top: 1px solid #e1e1da;
      }

      .card:first-child {
        border-top: 0;
        padding-top: 0;
      }

      .callsign {
        font-weight: 700;
      }

      .label {
        display: inline-block;
        min-width: 72px;
        color: #6a6a6a;
      }

      .row,
      .meta,
      .summary,
      .tags,
      .empty,
      .status {
        margin-top: 4px;
        color: #4b4b4b;
      }

      .status {
        margin-bottom: 24px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Radio Pilot</h1>
      <p>Live view of current band activity from the local Radio Pilot backend.</p>
      <div id="status" class="status">Loading opportunities...</div>
      <section>
        <h2>Best Opportunity</h2>
        <div id="best-opportunity"></div>
      </section>
      <section>
        <h2>Watch Next</h2>
        <div id="watch-next"></div>
      </section>
      <section>
        <h2>DX Opportunity</h2>
        <div id="dx-opportunity"></div>
      </section>
      <section>
        <h2>Nearby Activity</h2>
        <div id="nearby-activity"></div>
      </section>
    </main>
    <script>
      const sections = {
        bestOpportunity: document.getElementById("best-opportunity"),
        watchNext: document.getElementById("watch-next"),
        dxOpportunity: document.getElementById("dx-opportunity"),
        nearbyActivity: document.getElementById("nearby-activity"),
      };
      const status = document.getElementById("status");

      function formatCard(card) {
        const callsignRow = card.callsign
          ? '<div class="row"><span class="label">Callsign</span>' + escapeHtml(card.callsign) + '</div>'
          : "";
        const tags = Array.isArray(card.tags) && card.tags.length > 0 ? card.tags.join(", ") : "None";

        return [
          '<article class="card">',
          '<div class="row"><span class="label">Band</span>' + escapeHtml(card.band ?? "Unknown") + "</div>",
          callsignRow,
          '<div class="row summary"><span class="label">Summary</span>' + escapeHtml(card.summary) + "</div>",
          '<div class="row tags"><span class="label">Tags</span>' + escapeHtml(tags) + "</div>",
          "</article>",
        ].join("");
      }

      function renderList(element, cards) {
        if (!cards || cards.length === 0) {
          element.innerHTML = '<div class="empty">No data.</div>';
          return;
        }

        element.innerHTML = cards.map(formatCard).join("");
      }

      function renderSingle(element, card) {
        if (!card) {
          element.innerHTML = '<div class="empty">No data.</div>';
          return;
        }

        element.innerHTML = formatCard(card);
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      async function load() {
        try {
          const response = await fetch("http://localhost:3000/api/opportunities");

          if (!response.ok) {
            throw new Error("Request failed with status " + response.status);
          }

          const snapshot = await response.json();
          renderSingle(sections.bestOpportunity, snapshot.bestOpportunity);
          renderList(sections.watchNext, snapshot.watchNext);
          renderSingle(sections.dxOpportunity, snapshot.dxOpportunity);
          renderList(sections.nearbyActivity, snapshot.nearbyActivity);
          status.textContent = "Live data loaded.";
        } catch (error) {
          status.textContent = "Failed to load opportunities.";
          const message = error instanceof Error ? error.message : String(error);

          for (const element of Object.values(sections)) {
            element.innerHTML = '<div class="empty">' + escapeHtml(message) + '</div>';
          }
        }
      }

      load();
    </script>
  </body>
</html>`;
}
