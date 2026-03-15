import type { OpportunityCard, OpportunitySnapshot, ParsedSpot } from "@radio-pilot/shared";

const SNAPSHOT_INTERVAL_MS = 30_000;
const RECENT_WINDOW_MS = 15 * 60 * 1000;
const RECENT_RETENTION_MS = 60 * 60 * 1000;
const SNAPSHOT_KEY = "snapshot:default";
const homeContinent = process.env.HOME_CONTINENT?.trim().toUpperCase() ?? "";

interface StoredSpot extends ParsedSpot {
  readonly receivedAt: string;
  readonly rawLine?: string;
}

interface BandStats {
  readonly bandKey: string;
  readonly totalSpots: number;
  readonly uniqueCallsigns: number;
  readonly portableSpots: number;
  readonly offContinentSpots: number | null;
  readonly dominantModeFamily: ModeFamilyKey;
  readonly dominantDxContinent: string | null;
  readonly spots: readonly StoredSpot[];
  readonly modeFamilyCounts: Readonly<Record<ModeFamilyKey, number>>;
  readonly representative: StoredSpot;
}

type ModeFamilyKey = "cw" | "phone" | "digital" | "unknown";

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
  const minScore = now - RECENT_WINDOW_MS;
  await pruneRecentSortedSpots(redis, now);
  const rawSpots = await redis.zRangeByScore("spots:recent", minScore, now);
  const spots = rawSpots.flatMap(parseStoredSpot);
  const snapshot = buildOpportunitySnapshot(spots, now);

  await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

async function pruneRecentSortedSpots(
  redis: SnapshotRedisClient,
  now: number,
): Promise<void> {
  const cutoff = now - RECENT_RETENTION_MS;
  await redis.zRemRangeByScore("spots:recent", 0, cutoff);
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
    .flatMap(({ stats }) => {
      const representative = selectPortableRepresentativeSpot(stats.spots);
      return representative ? [createOpportunityCard(stats, representative)] : [];
    });
  const uniqueRankedBands = [...rankedBands].sort((left, right) => {
    if (right.stats.uniqueCallsigns !== left.stats.uniqueCallsigns) {
      return right.stats.uniqueCallsigns - left.stats.uniqueCallsigns;
    }

    return compareCards(left.card, right.card);
  });
  const dxRankedBands = [...rankedBands].sort((left, right) =>
    compareDxBandStats(left.stats, right.stats, left.card, right.card),
  );
  const dxOpportunity = hasAnyContinentData(statsByBand)
    ? createDxOpportunityCard(dxRankedBands.map(({ stats }) => stats))
    : uniqueRankedBands[0]?.card ?? null;

  return {
    generatedAt: new Date(now).toISOString(),
    cards: rankedCards,
    bestOpportunity: rankedCards[0] ?? null,
    watchNext: rankedCards.slice(1, 4),
    dxOpportunity,
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
      (spot) => isPortableSpot(spot),
    ).length;
    const offContinentSpots = countOffContinentSpots(bandSpots);
    const modeFamilyCounts = countModeFamilies(bandSpots);
    const dominantModeFamily = getDominantModeFamily(modeFamilyCounts);
    const dominantDxContinent = getDominantDxContinent(bandSpots);

    return {
      bandKey,
      totalSpots: bandSpots.length,
      uniqueCallsigns,
      portableSpots,
      offContinentSpots,
      dominantModeFamily,
      dominantDxContinent,
      spots: bandSpots,
      modeFamilyCounts,
      representative: selectRepresentativeSpot(bandSpots),
    };
  });
}

function createOpportunityCard(
  stats: BandStats,
  representative: StoredSpot = stats.representative,
): OpportunityCard {
  const score = scoreBand(stats);

  return {
    id: `${stats.bandKey}:${representative.spottedCallsign}`,
    callsign: representative.spottedCallsign,
    band: representative.band,
    frequencyKHz: representative.frequencyKHz,
    summary: buildCardSummary(stats),
    tags: representative.tags,
    score,
  };
}

function scoreBand(stats: BandStats): number {
  return stats.totalSpots * 100 + stats.uniqueCallsigns * 10 + stats.portableSpots * 25;
}

function selectRepresentativeSpot(spots: readonly StoredSpot[]): StoredSpot {
  return [...spots].sort((left, right) => {
    const timeDifference = getSpotSortTime(right) - getSpotSortTime(left);

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

async function runSnapshotLoop(redis: SnapshotRedisClient): Promise<void> {
  while (true) {
    await publishSnapshot(redis);
    await delay(SNAPSHOT_INTERVAL_MS);
  }
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
          id: typeof parsed.id === "string" ? parsed.id : buildLegacySpotId(parsed),
          source: typeof parsed.source === "string" ? parsed.source : "telnet",
          spotterCallsign: parsed.spotterCallsign,
          spottedCallsign: parsed.spottedCallsign,
          continentDx:
            typeof parsed.continentDx === "string" ? parsed.continentDx : undefined,
          frequencyKHz: parsed.frequencyKHz,
          frequencyHz:
            typeof parsed.frequencyHz === "number" ? parsed.frequencyHz : undefined,
          band: parsed.band ?? null,
          observedAt:
            typeof parsed.observedAt === "string" ? parsed.observedAt : undefined,
          mode: isParsedMode(parsed.mode) ? parsed.mode : undefined,
          modeFamily: isParsedModeFamily(parsed.modeFamily)
            ? parsed.modeFamily
            : undefined,
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

function isParsedMode(value: unknown): value is ParsedSpot["mode"] {
  return (
    value === "cw" ||
    value === "ssb" ||
    value === "ft8" ||
    value === "ft4" ||
    value === "digital" ||
    value === "unknown"
  );
}

function isParsedModeFamily(value: unknown): value is ParsedSpot["modeFamily"] {
  return (
    value === "cw" ||
    value === "phone" ||
    value === "digital" ||
    value === "unknown"
  );
}

function buildLegacySpotId(parsed: Partial<StoredSpot>): string {
  return [
    parsed.spotterCallsign ?? "",
    parsed.spottedCallsign ?? "",
    typeof parsed.frequencyKHz === "number" ? parsed.frequencyKHz.toFixed(1) : "",
    parsed.comment ?? "",
  ].join("|");
}

function countModeFamilies(spots: readonly StoredSpot[]): Readonly<Record<ModeFamilyKey, number>> {
  const counts: Record<ModeFamilyKey, number> = {
    cw: 0,
    phone: 0,
    digital: 0,
    unknown: 0,
  };

  for (const spot of spots) {
    counts[normalizeModeFamily(spot.modeFamily)] += 1;
  }

  return counts;
}

function isPortableSpot(spot: StoredSpot): boolean {
  return (
    spot.tags.includes("SOTA") ||
    spot.tags.includes("POTA") ||
    spot.tags.includes("WWFF") ||
    spot.tags.includes("/P")
  );
}

function countOffContinentSpots(spots: readonly StoredSpot[]): number | null {
  if (homeContinent.length === 0) {
    return null;
  }

  let availableCount = 0;
  let offContinentCount = 0;

  for (const spot of spots) {
    const continentDx = normalizeContinent(spot.continentDx);

    if (!continentDx) {
      continue;
    }

    availableCount += 1;

    if (continentDx !== homeContinent) {
      offContinentCount += 1;
    }
  }

  return availableCount > 0 ? offContinentCount : null;
}

function countDxContinents(spots: readonly StoredSpot[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const spot of spots) {
    const continentDx = normalizeContinent(spot.continentDx);

    if (!continentDx) {
      continue;
    }

    counts.set(continentDx, (counts.get(continentDx) ?? 0) + 1);
  }

  return counts;
}

function hasAnyContinentData(stats: readonly BandStats[]): boolean {
  return stats.some((statsItem) => statsItem.offContinentSpots !== null);
}

function createDxOpportunityCard(statsByBand: readonly BandStats[]): OpportunityCard | null {
  for (const stats of statsByBand) {
    const representative = selectOffContinentRepresentativeSpot(stats.spots);

    if (representative) {
      return createOpportunityCard(stats, representative);
    }
  }

  return statsByBand[0] ? createOpportunityCard(statsByBand[0]) : null;
}

function compareDxBandStats(
  left: BandStats,
  right: BandStats,
  leftCard: OpportunityCard,
  rightCard: OpportunityCard,
): number {
  const leftOffContinent = left.offContinentSpots;
  const rightOffContinent = right.offContinentSpots;

  if (leftOffContinent !== null || rightOffContinent !== null) {
    if (leftOffContinent === null) {
      return 1;
    }

    if (rightOffContinent === null) {
      return -1;
    }

    if (rightOffContinent !== leftOffContinent) {
      return rightOffContinent - leftOffContinent;
    }
  }

  if (right.uniqueCallsigns !== left.uniqueCallsigns) {
    return right.uniqueCallsigns - left.uniqueCallsigns;
  }

  return compareCards(leftCard, rightCard);
}

function getDominantModeFamily(modeFamilyCounts: Readonly<Record<ModeFamilyKey, number>>): ModeFamilyKey {
  const orderedModeFamilies: readonly ModeFamilyKey[] = [
    "digital",
    "phone",
    "cw",
    "unknown",
  ];

  return orderedModeFamilies.reduce((best, current) => {
    if (modeFamilyCounts[current] > modeFamilyCounts[best]) {
      return current;
    }

    return best;
  }, "unknown");
}

function getDominantDxContinent(spots: readonly StoredSpot[]): string | null {
  const continentCounts = countDxContinents(spots);
  let bestContinent: string | null = null;
  let bestCount = -1;

  for (const [continent, count] of [...continentCounts.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (count > bestCount) {
      bestContinent = continent;
      bestCount = count;
    }
  }

  return bestContinent;
}

function buildCardSummary(stats: BandStats): string {
  const summaryParts = [
    `${stats.totalSpots} spots`,
    `${stats.uniqueCallsigns} unique calls`,
    `${stats.portableSpots} portable`,
    `dominant ${stats.dominantModeFamily} mode`,
  ];

  if (stats.dominantDxContinent) {
    summaryParts.push(`dominant DX ${stats.dominantDxContinent}`);
  }

  return summaryParts.join(", ");
}

function selectPortableRepresentativeSpot(spots: readonly StoredSpot[]): StoredSpot | null {
  return selectPreferredRepresentativeSpot(spots, (spot) => isPortableSpot(spot));
}

function selectOffContinentRepresentativeSpot(spots: readonly StoredSpot[]): StoredSpot | null {
  if (homeContinent.length === 0) {
    return null;
  }

  return selectPreferredRepresentativeSpot(spots, (spot) => {
    const continentDx = normalizeContinent(spot.continentDx);
    return continentDx !== null && continentDx !== homeContinent;
  });
}

function selectPreferredRepresentativeSpot(
  spots: readonly StoredSpot[],
  predicate: (spot: StoredSpot) => boolean,
): StoredSpot | null {
  const preferredSpots = spots.filter(predicate);
  return preferredSpots.length > 0 ? selectRepresentativeSpot(preferredSpots) : null;
}

function getSpotSortTime(spot: StoredSpot): number {
  const observedAtMs =
    typeof spot.observedAt === "string" ? Date.parse(spot.observedAt) : Number.NaN;

  if (Number.isFinite(observedAtMs)) {
    return observedAtMs;
  }

  return Date.parse(spot.receivedAt);
}

function normalizeModeFamily(modeFamily: ParsedSpot["modeFamily"]): ModeFamilyKey {
  if (
    modeFamily === "cw" ||
    modeFamily === "phone" ||
    modeFamily === "digital" ||
    modeFamily === "unknown"
  ) {
    return modeFamily;
  }

  return "unknown";
}

function normalizeContinent(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
