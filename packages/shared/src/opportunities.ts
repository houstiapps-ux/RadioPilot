import {
  deriveContinentFromMaidenhead,
  estimatePathBetweenLocators,
  parseMaidenheadLocator,
} from "./maidenhead.js";
import type { OpportunityCard, OpportunitySnapshot, ParsedSpot } from "./types.js";

const RECENT_WINDOW_MS = 15 * 60 * 1000;

interface BuildOpportunitySnapshotOptions {
  readonly now?: number;
  readonly homeGrid?: string;
  readonly operatingStyle?: string;
}

export interface StoredOpportunitySpot extends ParsedSpot {
  readonly receivedAt: string;
  readonly rawLine?: string;
}

interface BandStats {
  readonly bandKey: string;
  readonly totalSpots: number;
  readonly uniqueCallsigns: number;
  readonly portableSpots: number;
  readonly activityTrend: number;
  readonly offContinentSpots: number | null;
  readonly dominantDirectionBucket: DirectionBucket | null;
  readonly dominantBearingDegrees: number | null;
  readonly dominantDirectionUniqueCallsigns: number;
  readonly directionSpread: number;
  readonly maxDistanceKm: number | null;
  readonly dominantDirection: string | null;
  readonly roughRegionLabel: string | null;
  readonly dominantModeFamily: ModeFamilyKey;
  readonly dominantDxContinent: string | null;
  readonly confidence: "Low" | "Medium" | "High";
  readonly spots: readonly StoredOpportunitySpot[];
  readonly modeFamilyCounts: Readonly<Record<ModeFamilyKey, number>>;
  readonly representative: StoredOpportunitySpot;
}

type ModeFamilyKey = "cw" | "phone" | "digital" | "unknown";
type PathEstimate = NonNullable<ReturnType<typeof estimatePathBetweenLocators>>;
interface DirectionalEstimate extends PathEstimate {
  readonly callsign: string;
}
type DirectionBucket = PathEstimate["direction"];

export function buildOpportunitySnapshot(
  allSpots: readonly StoredOpportunitySpot[],
  options: BuildOpportunitySnapshotOptions = {},
): OpportunitySnapshot {
  const now = options.now ?? Date.now();
  const currentWindowStart = now - RECENT_WINDOW_MS;
  const previousWindowStart = now - RECENT_WINDOW_MS * 2;
  const normalizedHomeGrid = normalizeHomeGrid(options.homeGrid);
  const normalizedHomeContinent = normalizedHomeGrid
    ? deriveContinentFromMaidenhead(normalizedHomeGrid)
    : undefined;
  const normalizedOperatingStyle = normalizeOperatingStyle(options.operatingStyle);
  const currentSpots = allSpots.filter((spot) => {
    const spotTime = getSpotSortTime(spot);
    return spotTime >= currentWindowStart && spotTime <= now;
  });
  const previousSpots = allSpots.filter((spot) => {
    const spotTime = getSpotSortTime(spot);
    return spotTime >= previousWindowStart && spotTime < currentWindowStart;
  });
  const statsByBand = buildBandStats(
    currentSpots,
    previousSpots,
    normalizedHomeContinent ?? null,
    normalizedHomeGrid,
  );
  const rankedBands = statsByBand
    .map((stats) => ({ stats, card: createOpportunityCard(stats) }))
    .sort((left, right) =>
      compareCards(left.card, right.card, left.stats, right.stats, normalizedOperatingStyle),
    );
  const rankedCards = rankedBands.map(({ card }) => card);
  const portableCards = rankedBands
    .flatMap(({ stats }) => {
      const representative = selectPortableRepresentativeSpot(stats.spots);
      return representative ? [createOpportunityCard(stats, representative)] : [];
    });
  const watchNextBands = [...rankedBands].sort((left, right) =>
    compareWatchNextBandStats(
      left.stats,
      right.stats,
      left.card,
      right.card,
      normalizedOperatingStyle,
    ),
  );
  const dxRankedBands = [...rankedBands].sort((left, right) =>
    compareDxBandStats(
      left.stats,
      right.stats,
      left.card,
      right.card,
      normalizedOperatingStyle,
    ),
  );
  const dxOpportunity = hasAnyContinentData(statsByBand)
    ? createDxOpportunityCard(
      dxRankedBands.map(({ stats }) => stats),
      normalizedHomeContinent ?? null,
    )
    : watchNextBands[0]?.card ?? null;

  return {
    generatedAt: new Date(now).toISOString(),
    cards: rankedCards,
    bestOpportunity: rankedCards[0] ?? null,
    watchNext: watchNextBands
      .filter(({ card }) => card.id !== (rankedCards[0]?.id ?? ""))
      .slice(0, 3)
      .map(({ card }) => card),
    dxOpportunity,
    nearbyActivity: portableCards.slice(0, 3),
  };
}

export function parseStoredOpportunitySpot(rawSpot: string): StoredOpportunitySpot[] {
  try {
    const parsed = JSON.parse(rawSpot) as Partial<StoredOpportunitySpot>;

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
          countryCode:
            typeof parsed.countryCode === "string" ? parsed.countryCode : undefined,
          dxLocator: getDxLocator(parsed),
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

function buildBandStats(
  currentSpots: readonly StoredOpportunitySpot[],
  previousSpots: readonly StoredOpportunitySpot[],
  homeContinent: string | null,
  homeGrid: string | undefined,
): BandStats[] {
  const bands = new Map<string, StoredOpportunitySpot[]>();
  const previousCounts = new Map<string, number>();

  for (const spot of currentSpots) {
    const bandKey = spot.band ?? "unknown";
    const existing = bands.get(bandKey);

    if (existing) {
      existing.push(spot);
    } else {
      bands.set(bandKey, [spot]);
    }
  }

  for (const spot of previousSpots) {
    const bandKey = spot.band ?? "unknown";
    previousCounts.set(bandKey, (previousCounts.get(bandKey) ?? 0) + 1);
  }

  return [...bands.entries()].map(([bandKey, bandSpots]) => {
    const uniqueCallsigns = new Set(bandSpots.map((spot) => spot.spottedCallsign)).size;
    const portableSpots = bandSpots.filter((spot) => isPortableSpot(spot)).length;
    const previousWindowSpots = previousCounts.get(bandKey) ?? 0;
    const activityTrend = bandSpots.length - previousWindowSpots;
    const offContinentSpots = countOffContinentSpots(bandSpots, homeContinent);
    const pathEstimates = collectPathEstimates(bandSpots, homeGrid);
    const directionalCluster = buildDirectionalCluster(pathEstimates);
    const modeFamilyCounts = countModeFamilies(bandSpots);
    const dominantModeFamily = getDominantModeFamily(modeFamilyCounts);
    const dominantDxContinent = getDominantDxContinent(bandSpots);
    const roughRegionLabel = getRoughRegionLabel(
      dominantDxContinent,
      directionalCluster.dominantDirection,
    );
    const confidence = getConfidenceLevel(
      directionalCluster.uniqueCallsigns,
      activityTrend,
      countActiveModeFamilies(modeFamilyCounts),
    );

    return {
      bandKey,
      totalSpots: bandSpots.length,
      uniqueCallsigns,
      portableSpots,
      activityTrend,
      offContinentSpots,
      dominantDirectionBucket: directionalCluster.dominantDirection,
      dominantBearingDegrees: directionalCluster.averageBearing,
      dominantDirectionUniqueCallsigns: directionalCluster.uniqueCallsigns,
      directionSpread: directionalCluster.spread,
      maxDistanceKm: getMaxDistanceKm(pathEstimates),
      dominantDirection: directionalCluster.dominantDirection
        ? getDirectionLabel(directionalCluster.dominantDirection)
        : null,
      roughRegionLabel,
      dominantModeFamily,
      dominantDxContinent,
      confidence,
      spots: bandSpots,
      modeFamilyCounts,
      representative: selectRepresentativeSpot(bandSpots),
    };
  });
}

function createOpportunityCard(
  stats: BandStats,
  representative: StoredOpportunitySpot = stats.representative,
): OpportunityCard {
  const score = scoreBand(stats);

  return {
    id: `${stats.bandKey}:${representative.spottedCallsign}`,
    callsign: representative.spottedCallsign,
    band: representative.band,
    frequencyKHz: representative.frequencyKHz,
    summary: buildCardSummary(stats),
    countryCode: representative.countryCode,
    direction: stats.dominantDirection ?? undefined,
    bearing: stats.dominantBearingDegrees ?? undefined,
    region: stats.roughRegionLabel ?? undefined,
    confidence: stats.confidence,
    tags: representative.tags,
    score,
  };
}

function scoreBand(stats: BandStats): number {
  return stats.totalSpots * 100 + stats.uniqueCallsigns * 10 + stats.portableSpots * 25;
}

function selectRepresentativeSpot(spots: readonly StoredOpportunitySpot[]): StoredOpportunitySpot {
  return [...spots].sort((left, right) => {
    const timeDifference = getSpotSortTime(right) - getSpotSortTime(left);

    if (timeDifference !== 0) {
      return timeDifference;
    }

    return left.spottedCallsign.localeCompare(right.spottedCallsign);
  })[0];
}

function compareCards(
  left: OpportunityCard,
  right: OpportunityCard,
  leftStats: BandStats,
  rightStats: BandStats,
  operatingStyle: "dx" | undefined,
): number {
  const leftScore = scoreCard(left, leftStats, operatingStyle);
  const rightScore = scoreCard(right, rightStats, operatingStyle);

  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }

  if (right.score !== left.score) {
    return right.score - left.score;
  }

  if ((left.band ?? "").localeCompare(right.band ?? "") !== 0) {
    return (left.band ?? "").localeCompare(right.band ?? "");
  }

  return left.callsign.localeCompare(right.callsign);
}

function compareWatchNextBandStats(
  left: BandStats,
  right: BandStats,
  leftCard: OpportunityCard,
  rightCard: OpportunityCard,
  operatingStyle: "dx" | undefined,
): number {
  const leftIncreasing = left.activityTrend > 0 ? 1 : 0;
  const rightIncreasing = right.activityTrend > 0 ? 1 : 0;

  if (rightIncreasing !== leftIncreasing) {
    return rightIncreasing - leftIncreasing;
  }

  if (right.activityTrend !== left.activityTrend) {
    return right.activityTrend - left.activityTrend;
  }

  return compareCards(leftCard, rightCard, left, right, operatingStyle);
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

function buildLegacySpotId(parsed: Partial<StoredOpportunitySpot>): string {
  return [
    parsed.spotterCallsign ?? "",
    parsed.spottedCallsign ?? "",
    typeof parsed.frequencyKHz === "number" ? parsed.frequencyKHz.toFixed(1) : "",
    parsed.comment ?? "",
  ].join("|");
}

function countModeFamilies(
  spots: readonly StoredOpportunitySpot[],
): Readonly<Record<ModeFamilyKey, number>> {
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

function isPortableSpot(spot: StoredOpportunitySpot): boolean {
  return (
    spot.tags.includes("SOTA") ||
    spot.tags.includes("POTA") ||
    spot.tags.includes("WWFF") ||
    spot.tags.includes("/P")
  );
}

function countOffContinentSpots(
  spots: readonly StoredOpportunitySpot[],
  homeContinent: string | null,
): number | null {
  if (!homeContinent) {
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

function countDxContinents(spots: readonly StoredOpportunitySpot[]): ReadonlyMap<string, number> {
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

function buildDirectionalCluster(pathEstimates: readonly DirectionalEstimate[]): {
  dominantDirection: DirectionBucket | null;
  averageBearing: number | null;
  uniqueCallsigns: number;
  spread: number;
} {
  if (pathEstimates.length === 0) {
    return {
      dominantDirection: null,
      averageBearing: null,
      uniqueCallsigns: 0,
      spread: 0,
    };
  }

  const counts = new Map<DirectionBucket, Set<string>>();
  const bearings = new Map<DirectionBucket, number[]>();

  for (const estimate of pathEstimates) {
    const key = estimate.direction;
    const existingSet = counts.get(key) ?? new Set<string>();
    existingSet.add(estimate.callsign);
    counts.set(key, existingSet);

    const existingBearings = bearings.get(key) ?? [];
    existingBearings.push(estimate.bearingDegrees);
    bearings.set(key, existingBearings);
  }

  let dominantDirection: DirectionBucket | null = null;
  let dominantCount = -1;
  let runnerUpCount = 0;

  for (const direction of getDirectionOrder()) {
    const count = counts.get(direction)?.size ?? 0;

    if (count > dominantCount) {
      runnerUpCount = dominantCount;
      dominantDirection = direction;
      dominantCount = count;
      continue;
    }

    if (count > runnerUpCount) {
      runnerUpCount = count;
    }
  }

  if (dominantDirection === null || dominantCount <= 0) {
    return {
      dominantDirection: null,
      averageBearing: null,
      uniqueCallsigns: 0,
      spread: 0,
    };
  }

  const averageBearing = averageBearings(bearings.get(dominantDirection) ?? []);
  const spread = dominantCount - Math.max(runnerUpCount, 0);

  return {
    dominantDirection: spread > 0 ? dominantDirection : null,
    averageBearing: spread > 0 ? averageBearing : null,
    uniqueCallsigns: dominantCount,
    spread,
  };
}

function collectPathEstimates(
  spots: readonly StoredOpportunitySpot[],
  homeGrid: string | undefined,
): readonly DirectionalEstimate[] {
  if (!homeGrid) {
    return [];
  }

  return spots.flatMap((spot) => {
    const dxLocator = normalizeHomeGrid(spot.dxLocator);

    if (!dxLocator) {
      return [];
    }

    const estimate = estimatePathBetweenLocators(homeGrid, dxLocator);
    return estimate ? [{ ...estimate, callsign: spot.spottedCallsign }] : [];
  });
}

function hasAnyContinentData(stats: readonly BandStats[]): boolean {
  return stats.some((statsItem) => statsItem.offContinentSpots !== null);
}

function createDxOpportunityCard(
  statsByBand: readonly BandStats[],
  homeContinent: string | null,
): OpportunityCard | null {
  for (const stats of statsByBand) {
    const representative = selectOffContinentRepresentativeSpot(stats.spots, homeContinent);

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
  operatingStyle: "dx" | undefined,
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

  return compareCards(leftCard, rightCard, left, right, operatingStyle);
}

function getDominantModeFamily(
  modeFamilyCounts: Readonly<Record<ModeFamilyKey, number>>,
): ModeFamilyKey {
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

function getDominantDxContinent(spots: readonly StoredOpportunitySpot[]): string | null {
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
  ];

  if (stats.roughRegionLabel) {
    summaryParts.push(`${stats.roughRegionLabel} opening`);
  }

  if (stats.dominantDirection && stats.dominantBearingDegrees !== null) {
    summaryParts.push(
      `${stats.dominantDirection} (${stats.dominantBearingDegrees}°)`,
    );
  }

  summaryParts.push(`${formatModeFamily(stats.dominantModeFamily)} likely good`);
  summaryParts.push(`Confidence: ${stats.confidence}`);

  return summaryParts.join(", ");
}

function selectPortableRepresentativeSpot(
  spots: readonly StoredOpportunitySpot[],
): StoredOpportunitySpot | null {
  return selectPreferredRepresentativeSpot(spots, (spot) => isPortableSpot(spot));
}

function selectOffContinentRepresentativeSpot(
  spots: readonly StoredOpportunitySpot[],
  homeContinent: string | null,
): StoredOpportunitySpot | null {
  if (!homeContinent) {
    return null;
  }

  return selectPreferredRepresentativeSpot(spots, (spot) => {
    const continentDx = normalizeContinent(spot.continentDx);
    return continentDx !== null && continentDx !== homeContinent;
  });
}

function selectPreferredRepresentativeSpot(
  spots: readonly StoredOpportunitySpot[],
  predicate: (spot: StoredOpportunitySpot) => boolean,
): StoredOpportunitySpot | null {
  const preferredSpots = spots.filter(predicate);
  return preferredSpots.length > 0 ? selectRepresentativeSpot(preferredSpots) : null;
}

function getSpotSortTime(spot: StoredOpportunitySpot): number {
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

function normalizeHomeGrid(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return parseMaidenheadLocator(normalized) ? normalized : undefined;
}

function normalizeOperatingStyle(value: unknown): "dx" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim().toLowerCase() === "dx" ? "dx" : undefined;
}

function getDxLocator(parsed: Partial<StoredOpportunitySpot>): string | undefined {
  const rawDxLocator =
    typeof parsed.dxLocator === "string"
      ? parsed.dxLocator
      : typeof Reflect.get(parsed, "DXLocator") === "string"
        ? Reflect.get(parsed, "DXLocator")
        : undefined;

  return normalizeHomeGrid(rawDxLocator);
}

function getMaxDistanceKm(
  pathEstimates: readonly DirectionalEstimate[],
): number | null {
  if (pathEstimates.length === 0) {
    return null;
  }

  return pathEstimates.reduce(
    (best, current) => (current.distanceKm > best ? current.distanceKm : best),
    0,
  );
}

function getDominantDirection(
  pathEstimates: readonly DirectionalEstimate[],
): string | null {
  if (pathEstimates.length === 0) {
    return null;
  }

  const counts = new Map<string, number>();

  for (const estimate of pathEstimates) {
    counts.set(estimate.direction, (counts.get(estimate.direction) ?? 0) + 1);
  }

  let bestDirection: string | null = null;
  let bestCount = -1;

  for (const [direction, count] of [...counts.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (count > bestCount) {
      bestDirection = direction;
      bestCount = count;
    }
  }

  return bestDirection;
}

function scoreCard(
  card: OpportunityCard,
  stats: BandStats,
  operatingStyle: "dx" | undefined,
): number {
  let score = card.score;

  if (stats.offContinentSpots !== null) {
    score += stats.offContinentSpots * 40;
  }

  score += stats.dominantDirectionUniqueCallsigns * 20;
  score += Math.max(stats.directionSpread, 0) * 15;
  score += countActiveModeFamilies(stats.modeFamilyCounts) * 12;

  if (operatingStyle === "dx") {
    if (stats.offContinentSpots !== null) {
      score += stats.offContinentSpots * 60;
    }

    if (stats.maxDistanceKm !== null) {
      score += Math.round(stats.maxDistanceKm / 250);
    }
  }

  return score;
}

function countActiveModeFamilies(
  modeFamilyCounts: Readonly<Record<ModeFamilyKey, number>>,
): number {
  return (["cw", "phone", "digital"] as const).filter(
    (key) => modeFamilyCounts[key] > 0,
  ).length;
}

function getConfidenceLevel(
  directionalUniqueCallsigns: number,
  activityTrend: number,
  activeModeFamilies: number,
): "Low" | "Medium" | "High" {
  let confidencePoints = 0;

  if (directionalUniqueCallsigns >= 5) {
    confidencePoints += 2;
  } else if (directionalUniqueCallsigns >= 3) {
    confidencePoints += 1;
  }

  if (activityTrend > 0) {
    confidencePoints += 1;
  }

  if (activeModeFamilies >= 2) {
    confidencePoints += 1;
  }

  if (confidencePoints >= 3) {
    return "High";
  }

  if (confidencePoints >= 1) {
    return "Medium";
  }

  return "Low";
}

function getRoughRegionLabel(
  continent: string | null,
  direction: DirectionBucket | null,
): string | null {
  if (continent === "NA") {
    return "North America";
  }

  if (continent === "SA") {
    return "South America";
  }

  if (continent === "EU") {
    return "Europe";
  }

  if (continent === "AF") {
    return "Africa";
  }

  if (continent === "AS") {
    return "Asia";
  }

  if (continent === "OC") {
    return "Oceania";
  }

  if (continent === "AN") {
    return "Antarctica";
  }

  if (direction) {
    return getDirectionLabel(direction);
  }

  return null;
}

function getDirectionLabel(direction: DirectionBucket): string {
  const labels: Record<DirectionBucket, string> = {
    N: "North",
    NE: "North-East",
    E: "East",
    SE: "South-East",
    S: "South",
    SW: "South-West",
    W: "West",
    NW: "North-West",
  };

  return labels[direction];
}

function averageBearings(bearings: readonly number[]): number | null {
  if (bearings.length === 0) {
    return null;
  }

  const vector = bearings.reduce(
    (current, bearing) => {
      const radians = bearing * (Math.PI / 180);

      return {
        x: current.x + Math.cos(radians),
        y: current.y + Math.sin(radians),
      };
    },
    { x: 0, y: 0 },
  );

  const average = Math.atan2(vector.y, vector.x) * (180 / Math.PI);
  return Math.round((average + 360) % 360);
}

function getDirectionOrder(): readonly DirectionBucket[] {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
}

function formatModeFamily(modeFamily: ModeFamilyKey): string {
  if (modeFamily === "phone") {
    return "Voice / phone";
  }

  if (modeFamily === "digital") {
    return "Digital";
  }

  if (modeFamily === "cw") {
    return "CW";
  }

  return "Mixed modes";
}
