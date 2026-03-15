import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Fastify from "fastify";

import {
  predictBandOpenings,
  buildOpportunitySnapshotWithDebug,
  findNearbyOpportunities,
  getDirectionalPropagation,
  loadDxRarityContext,
  getAllBandTrends,
  parseMaidenheadLocator,
  parseStoredOpportunitySpot,
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
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";
// Local development should use the public Railway Redis URL from the repo root .env.
// Railway deployments should set REDIS_URL to the Redis private endpoint in Railway service variables.
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const app = Fastify({ logger: false });
const redis = createClient({ url: redisUrl });

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
    messagesLast10s: metrics?.messagesLast10s ?? 0,
    activeBands: getActivePskBands(summary),
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
  return await getDirectionalPropagation(redis, { homeGrid });
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
  messagesLast10s: number;
  updatedAt: string;
} | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<{
      mqttConnected: boolean;
      messagesLast10s: number;
      updatedAt: string;
    }>;

    if (
      typeof parsed.mqttConnected === "boolean" &&
      typeof parsed.messagesLast10s === "number" &&
      typeof parsed.updatedAt === "string"
    ) {
      return {
        mqttConnected: parsed.mqttConnected,
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
  const now = Date.now();
  const [rawSpots, rawSolar, rawPsk, pskTrends, bandPredictions, propagationDensity] = await Promise.all([
    redis.zRangeByScore("spots:recent", now - RECENT_WINDOW_MS * 2, now),
    redis.get("solar:latest"),
    redis.get("psk:summary"),
    getAllBandTrends(redis),
    predictBandOpenings(redis, { homeGrid }),
    getDirectionalPropagation(redis, { homeGrid }),
  ]);
  const spots = rawSpots.flatMap(parseStoredOpportunitySpot);
  const dxRarity = await loadDxRarityContext(redis, spots, now);
  const solar = parseSolar(rawSolar);
  const pskSummary = parsePskSummary(rawPsk);
  const spotsWithDxLocator = spots.filter((spot) => typeof spot.dxLocator === "string").length;

  // Temporary request-time trace to verify that homeGrid personalization is actually being applied.
  console.info(
    `[${source}] opportunities personalization`,
    JSON.stringify({
      homeGrid: homeGrid ?? null,
      operatingStyle: operatingStyle ?? null,
      spotCount: spots.length,
      spotsWithDxLocator,
    }),
  );

  if (spots.length === 0) {
    const empty = {
      ...emptySnapshot(),
      solar,
    };

    return { snapshot: empty, bands: [], dxCandidates: [] };
  }

  const built = buildOpportunitySnapshotWithDebug(spots, {
    now,
    homeGrid,
    operatingStyle,
    pskSummary: isFreshPskSummary(pskSummary, now) ? pskSummary : null,
    pskTrends: filterFreshPskTrends(pskTrends, now),
    dxRarity,
    solar,
    bandPredictions,
    propagationDensity,
  });
  const snapshot = {
    ...built.snapshot,
    solar,
  };

  return { ...built, snapshot };
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
