import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Fastify from "fastify";

import type { OpportunitySnapshot } from "@radio-pilot/shared";
import { createClient } from "redis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

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
});

await redis.connect();

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

app.get("/api/opportunities", async () => {
  const rawSnapshot = await redis.get("snapshot:default");
  return parseSnapshot(rawSnapshot) ?? emptySnapshot();
});

app.get("/debug/recent-spots", async () => {
  const values = await redis.zRange("spots:recent", 0, 19, { REV: true });
  return values.map((value) => parseJson(value) ?? value);
});

app.get("/debug/snapshot", async () => {
  const rawSnapshot = await redis.get("snapshot:default");
  return parseSnapshot(rawSnapshot);
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

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
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

      .meta,
      .summary,
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
        return [
          '<article class="card">',
          '<div class="callsign">' + escapeHtml(card.callsign) + '</div>',
          '<div class="meta">' + escapeHtml(formatMeta(card)) + '</div>',
          '<div class="summary">' + escapeHtml(card.summary) + '</div>',
          "</article>",
        ].join("");
      }

      function formatMeta(card) {
        const parts = [];

        if (card.band) {
          parts.push(card.band);
        }

        parts.push(card.frequencyKHz.toFixed(1) + " kHz");
        parts.push("score " + card.score);

        return parts.join(" • ");
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
          const response = await fetch("/api/opportunities");

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
