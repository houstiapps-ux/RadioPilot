import {
  parseStoredActivation,
  buildOpportunitySnapshot,
  parseStoredOpportunitySpot,
  type SolarConditions,
} from "@radio-pilot/shared";

const SNAPSHOT_INTERVAL_MS = 30_000;
const RECENT_WINDOW_MS = 15 * 60 * 1000;
const RECENT_RETENTION_MS = 60 * 60 * 1000;
const ACTIVATION_RETENTION_MS = 6 * 60 * 60 * 1000;
const SNAPSHOT_KEY = "snapshot:default";
const SOLAR_KEY = "solar:latest";
const homeGrid = process.env.HOME_GRID;

interface SnapshotRedisClient {
  zRangeByScore(key: string, min: number, max: number): Promise<string[]>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export function startSnapshotLoop(redis: SnapshotRedisClient): void {
  void runSnapshotLoop(redis).catch((error: unknown) => {
    console.error("Snapshot loop exited unexpectedly", error);
  });
}

async function publishSnapshot(redis: SnapshotRedisClient): Promise<void> {
  const now = Date.now();
  const minScore = now - RECENT_WINDOW_MS * 2;
  await pruneRecentSortedSpots(redis, now);
  const rawSpots = await redis.zRangeByScore("spots:recent", minScore, now);
  const spots = rawSpots.flatMap(parseStoredOpportunitySpot);
  const rawActivations = await redis.zRangeByScore("activations:recent", now - ACTIVATION_RETENTION_MS, now);
  const recentActivations = rawActivations.flatMap(parseStoredActivation);
  const snapshot = buildOpportunitySnapshot(spots, { now, homeGrid });
  const solar = parseSolar(await redis.get(SOLAR_KEY));

  await redis.set(SNAPSHOT_KEY, JSON.stringify({
    ...snapshot,
    solar,
  }));

  void recentActivations;
}

async function pruneRecentSortedSpots(
  redis: SnapshotRedisClient,
  now: number,
): Promise<void> {
  const cutoff = now - RECENT_RETENTION_MS;
  await redis.zRemRangeByScore("spots:recent", 0, cutoff);
}

async function runSnapshotLoop(redis: SnapshotRedisClient): Promise<void> {
  while (true) {
    try {
      await publishSnapshot(redis);
    } catch (error) {
      console.error("Snapshot publish failed; loop continues", error);
    }

    await delay(SNAPSHOT_INTERVAL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      };
    }
  } catch {
    return null;
  }

  return null;
}
