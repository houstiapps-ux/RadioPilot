import type { OpportunityCard, OpportunitySnapshot, ParsedSpot } from "@radio-pilot/shared";

const SNAPSHOT_INTERVAL_MS = 30_000;
const RECENT_WINDOW_MS = 15 * 60 * 1000;
const SNAPSHOT_KEY = "snapshot:default";

interface StoredSpot extends ParsedSpot {
  readonly receivedAt: string;
  readonly rawLine?: string;
}

interface BandStats {
  readonly bandKey: string;
  readonly totalSpots: number;
  readonly uniqueCallsigns: number;
  readonly portableSpots: number;
  readonly representative: StoredSpot;
}

interface SnapshotRedisClient {
  zRangeByScore(key: string, min: number, max: number): Promise<string[]>;
  set(key: string, value: string): Promise<unknown>;
}

export function startSnapshotLoop(redis: SnapshotRedisClient): void {
  void publishSnapshot(redis);
  setInterval(() => {
    void publishSnapshot(redis);
  }, SNAPSHOT_INTERVAL_MS);
}

async function publishSnapshot(redis: SnapshotRedisClient): Promise<void> {
  const now = Date.now();
  const minScore = now - RECENT_WINDOW_MS;
  const rawSpots = await redis.zRangeByScore("spots:recent", minScore, now);
  const spots = rawSpots.flatMap(parseStoredSpot);
  const snapshot = buildOpportunitySnapshot(spots, now);

  await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function buildOpportunitySnapshot(
  spots: readonly StoredSpot[],
  now = Date.now(),
): OpportunitySnapshot {
  const statsByBand = buildBandStats(spots);
  const rankedBands = statsByBand
    .map((stats) => ({ stats, card: createOpportunityCard(stats) }))
    .sort((left, right) => compareCards(left.card, right.card));
  const rankedCards = rankedBands.map(({ card }) => card);
  const portableCards = rankedBands
    .filter(({ stats }) => stats.portableSpots > 0)
    .map(({ card }) => card);
  const uniqueRankedBands = [...rankedBands].sort((left, right) => {
    if (right.stats.uniqueCallsigns !== left.stats.uniqueCallsigns) {
      return right.stats.uniqueCallsigns - left.stats.uniqueCallsigns;
    }

    return compareCards(left.card, right.card);
  });

  return {
    generatedAt: new Date(now).toISOString(),
    cards: rankedCards,
    bestOpportunity: rankedCards[0] ?? null,
    watchNext: rankedCards.slice(1, 4),
    dxOpportunity: uniqueRankedBands[0]?.card ?? null,
    nearbyActivity: portableCards.slice(0, 3),
  };
}

function buildBandStats(spots: readonly StoredSpot[]): BandStats[] {
  const bands = new Map<string, StoredSpot[]>();

  for (const spot of spots) {
    const bandKey = spot.band ?? "unknown";
    const existing = bands.get(bandKey);

    if (existing) {
      existing.push(spot);
    } else {
      bands.set(bandKey, [spot]);
    }
  }

  return [...bands.entries()].map(([bandKey, bandSpots]) => {
    const uniqueCallsigns = new Set(bandSpots.map((spot) => spot.spottedCallsign)).size;
    const portableSpots = bandSpots.filter(
      (spot) => spot.tags.includes("SOTA") || spot.tags.includes("POTA"),
    ).length;

    return {
      bandKey,
      totalSpots: bandSpots.length,
      uniqueCallsigns,
      portableSpots,
      representative: selectRepresentativeSpot(bandSpots),
    };
  });
}

function createOpportunityCard(stats: BandStats): OpportunityCard {
  const { representative } = stats;
  const score = scoreBand(stats);

  return {
    id: `${stats.bandKey}:${representative.spottedCallsign}`,
    callsign: representative.spottedCallsign,
    band: representative.band,
    frequencyKHz: representative.frequencyKHz,
    summary: `${stats.totalSpots} spots, ${stats.uniqueCallsigns} unique calls, ${stats.portableSpots} portable`,
    tags: representative.tags,
    score,
  };
}

function scoreBand(stats: BandStats): number {
  return stats.totalSpots * 100 + stats.uniqueCallsigns * 10 + stats.portableSpots * 25;
}

function selectRepresentativeSpot(spots: readonly StoredSpot[]): StoredSpot {
  return [...spots].sort((left, right) => {
    const timeDifference =
      Date.parse(right.receivedAt) - Date.parse(left.receivedAt);

    if (timeDifference !== 0) {
      return timeDifference;
    }

    return left.spottedCallsign.localeCompare(right.spottedCallsign);
  })[0];
}

function compareCards(left: OpportunityCard, right: OpportunityCard): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  if ((left.band ?? "").localeCompare(right.band ?? "") !== 0) {
    return (left.band ?? "").localeCompare(right.band ?? "");
  }

  return left.callsign.localeCompare(right.callsign);
}

function parseStoredSpot(rawSpot: string): StoredSpot[] {
  try {
    const parsed = JSON.parse(rawSpot) as Partial<StoredSpot>;

    if (
      typeof parsed.spotterCallsign === "string" &&
      typeof parsed.spottedCallsign === "string" &&
      typeof parsed.frequencyKHz === "number" &&
      typeof parsed.comment === "string" &&
      typeof parsed.receivedAt === "string" &&
      Array.isArray(parsed.tags)
    ) {
      return [
        {
          spotterCallsign: parsed.spotterCallsign,
          spottedCallsign: parsed.spottedCallsign,
          frequencyKHz: parsed.frequencyKHz,
          band: parsed.band ?? null,
          comment: parsed.comment,
          tags: parsed.tags,
          receivedAt: parsed.receivedAt,
          rawLine: parsed.rawLine,
        },
      ];
    }
  } catch {
    return [];
  }

  return [];
}
