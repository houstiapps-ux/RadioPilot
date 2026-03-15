import {
  buildOpportunitySnapshot,
  parseStoredOpportunitySpot,
} from "@radio-pilot/shared";

const SNAPSHOT_INTERVAL_MS = 30_000;
const RECENT_WINDOW_MS = 15 * 60 * 1000;
const RECENT_RETENTION_MS = 60 * 60 * 1000;
const SNAPSHOT_KEY = "snapshot:default";
const homeGrid = process.env.HOME_GRID;

interface SnapshotRedisClient {
  zRangeByScore(key: string, min: number, max: number): Promise<string[]>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<number>;
  set(key: string, value: string): Promise<unknown>;
}

export function startSnapshotLoop(redis: SnapshotRedisClient): void {
  void runSnapshotLoop(redis);
}

async function publishSnapshot(redis: SnapshotRedisClient): Promise<void> {
  const now = Date.now();
  const minScore = now - RECENT_WINDOW_MS * 2;
  await pruneRecentSortedSpots(redis, now);
  const rawSpots = await redis.zRangeByScore("spots:recent", minScore, now);
  const spots = rawSpots.flatMap(parseStoredOpportunitySpot);
  const snapshot = buildOpportunitySnapshot(spots, { now, homeGrid });

  await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
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
    await publishSnapshot(redis);
    await delay(SNAPSHOT_INTERVAL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
