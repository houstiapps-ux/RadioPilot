import Fastify from "fastify";

import type { OpportunitySnapshot } from "@radio-pilot/shared";
import { createClient } from "redis";

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";
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
