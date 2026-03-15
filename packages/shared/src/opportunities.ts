import {
  scoreDxCandidate,
  type DxRarityContext,
} from "./dxRarity.js";
import { findNearbyOpportunities } from "./nearbyEngine.js";
import {
  deriveContinentFromMaidenhead,
  estimatePathBetweenLocators,
  parseMaidenheadLocator,
} from "./maidenhead.js";
import type {
  BandPredictionMap,
  OpportunityCard,
  OpportunitySnapshot,
  ParsedSpot,
  PropagationDensityMap,
  PskBandTrendMap,
  PskReporterSummary,
  SolarConditions,
} from "./types.js";

const RECENT_WINDOW_MS = 15 * 60 * 1000;

interface BuildOpportunitySnapshotOptions {
  readonly now?: number;
  readonly homeGrid?: string;
  readonly operatingStyle?: string;
  readonly pskSummary?: PskReporterSummary | null;
  readonly pskTrends?: PskBandTrendMap | null;
  readonly dxRarity?: DxRarityContext | null;
  readonly solar?: SolarConditions | null;
  readonly bandPredictions?: BandPredictionMap | null;
  readonly propagationDensity?: PropagationDensityMap | null;
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
  readonly pskCurrent: number;
  readonly pskPrevious: number;
  readonly pskTrendRising: boolean;
  readonly pskBandBoostApplied: boolean;
  readonly pskModeBoostApplied: boolean;
  readonly pskTrendLabel: "rising" | "steady" | "falling";
  readonly pskTrendConfidence: "High" | "Medium" | "Low" | null;
  readonly predictedBandState: "opening" | "stable" | "fading";
  readonly predictedBandScore: number;
  readonly predictorSignals: readonly string[];
  readonly propagationDirectionConfidence: "High" | "Medium" | "Low";
  readonly propagationBeamHeading: number | null;
  readonly propagationDirectionBucket: DirectionBucket | null;
  readonly propagationSector: string | null;
  readonly propagationSignals: readonly string[];
  readonly spots: readonly StoredOpportunitySpot[];
  readonly modeFamilyCounts: Readonly<Record<ModeFamilyKey, number>>;
  readonly representative: StoredOpportunitySpot;
}

export interface OpportunityDebugBand {
  readonly band: string;
  readonly pskCurrent: number;
  readonly pskPrevious: number;
  readonly pskBoostApplied: boolean;
  readonly pskTrend?: "rising" | "steady" | "falling";
}

export interface OpportunityDebugDxCandidate {
  readonly callsign: string;
  readonly entity?: string;
  readonly band: string;
  readonly activityScore: number;
  readonly rarityScore: number;
  readonly pathScore: number;
  readonly solarScore: number;
  readonly dxScore: number;
}

export interface OpportunityDebugSnapshot {
  readonly snapshot: OpportunitySnapshot;
  readonly bands: readonly OpportunityDebugBand[];
  readonly dxCandidates: readonly OpportunityDebugDxCandidate[];
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
  return buildOpportunitySnapshotWithDebug(allSpots, options).snapshot;
}

export function buildOpportunitySnapshotWithDebug(
  allSpots: readonly StoredOpportunitySpot[],
  options: BuildOpportunitySnapshotOptions = {},
): OpportunityDebugSnapshot {
  const now = options.now ?? Date.now();
  const currentWindowStart = now - RECENT_WINDOW_MS;
  const previousWindowStart = now - RECENT_WINDOW_MS * 2;
  const normalizedHomeGrid = normalizeHomeGrid(options.homeGrid);
  const normalizedHomeContinent = normalizedHomeGrid
    ? deriveContinentFromMaidenhead(normalizedHomeGrid)
    : undefined;
  const normalizedOperatingStyle = normalizeOperatingStyle(options.operatingStyle);
  const pskByBand = indexPskSummaryByBand(options.pskSummary);
  const pskTrends = options.pskTrends ?? {};
  const dxRarity = options.dxRarity ?? null;
  const solar = options.solar ?? null;
  const bandPredictions = options.bandPredictions ?? {};
  const propagationDensity = options.propagationDensity ?? {};
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
    pskByBand,
    pskTrends,
    bandPredictions,
    propagationDensity,
  );
  const rankedBands = statsByBand
    .map((stats) => ({
      stats,
      card: createOpportunityCard(stats, stats.representative, normalizedHomeGrid, solar, now),
    }))
    .sort((left, right) =>
      compareCards(left.card, right.card, left.stats, right.stats, normalizedOperatingStyle),
    );
  const rankedCards = rankedBands.map(({ card }, index) =>
    withCardType(card, index === 0 ? "best" : "watch")
  );
  const nearby = findNearbyOpportunities(
    { homeGrid: normalizedHomeGrid },
    currentSpots,
    undefined,
    now,
  );
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
  const dxCandidates = buildDxCandidates(
    dxRankedBands.map(({ stats }) => stats),
    normalizedHomeContinent ?? null,
    normalizedHomeGrid,
    dxRarity,
    solar,
  );
  const dxOpportunity = selectDxOpportunityCard(
    dxCandidates,
    rankedCards[0] ?? null,
    watchNextBands[0]?.card ? withCardType(watchNextBands[0].card, "watch") : null,
  );

  const snapshot = {
    generatedAt: new Date(now).toISOString(),
    cards: rankedCards,
    bestOpportunity: rankedCards[0] ?? null,
    watchNext: watchNextBands
      .filter(({ card }) => card.id !== (rankedCards[0]?.id ?? ""))
      .slice(0, 3)
      .map(({ card }) => withCardType(card, "watch")),
    dxOpportunity: dxOpportunity ? withCardType(dxOpportunity, "dx") : null,
    nearbyActivity: nearby.cards.slice(0, 3),
  };

  return {
    snapshot,
    bands: statsByBand.map((stats) => ({
      band: stats.bandKey,
      pskCurrent: stats.pskCurrent,
      pskPrevious: stats.pskPrevious,
      pskBoostApplied: stats.pskBandBoostApplied || stats.pskModeBoostApplied,
      pskTrend: stats.pskTrendLabel,
    })),
    dxCandidates: dxCandidates.map((candidate) => ({
      callsign: candidate.card.callsign,
      entity: candidate.entity,
      band: candidate.card.band ?? "unknown",
      activityScore: roundDebugScore(candidate.activityScore),
      rarityScore: roundDebugScore(candidate.rarityScore),
      pathScore: roundDebugScore(candidate.pathScore),
      solarScore: roundDebugScore(candidate.solarScore),
      dxScore: roundDebugScore(candidate.dxScore),
    })),
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
  pskByBand: ReadonlyMap<string, PskBandSummary>,
  pskTrends: PskBandTrendMap,
  bandPredictions: BandPredictionMap,
  propagationDensity: PropagationDensityMap,
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
    const pskBand = pskByBand.get(bandKey) ?? emptyPskBandSummary();
    const pskTrend = pskTrends[bandKey as keyof PskBandTrendMap] ?? null;
    const prediction = bandPredictions[bandKey as keyof BandPredictionMap] ?? null;
    const density = propagationDensity[bandKey as keyof PropagationDensityMap] ?? null;
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
      pskCurrent: pskBand.current,
      pskPrevious: pskBand.previous,
      pskTrendRising: pskBand.rising,
      pskBandBoostApplied: pskBand.current > 50,
      pskModeBoostApplied: shouldApplyPskModeBoost(
        pskBand.modeCounts,
        dominantModeFamily,
      ),
      pskTrendLabel: pskTrend?.trend ?? "steady",
      pskTrendConfidence: pskTrend?.confidence ?? null,
      predictedBandState: prediction?.state ?? "stable",
      predictedBandScore: prediction?.score ?? 0.5,
      predictorSignals: prediction?.signals ?? [],
      propagationDirectionConfidence: density?.confidence ?? "Low",
      propagationBeamHeading: typeof density?.beamHeading === "number" ? density.beamHeading : null,
      propagationDirectionBucket: density?.dominantDirection ?? null,
      propagationSector: density?.sector ?? null,
      propagationSignals: buildPropagationSignals(density),
      spots: bandSpots,
      modeFamilyCounts,
      representative: selectRepresentativeSpot(bandSpots),
    };
  });
}

function createOpportunityCard(
  stats: BandStats,
  representative: StoredOpportunitySpot = stats.representative,
  homeGrid?: string,
  solar: SolarConditions | null = null,
  now = Date.now(),
): OpportunityCard {
  const score = scoreBand(stats);
  const pathEstimate = getRepresentativePathEstimate(representative, homeGrid);
  const modeSummary = getModeSummary(stats, representative);
  const entity = getEntityName(representative.countryCode);
  const freshnessSeconds = getFreshnessSeconds(representative, now);
  const activityLevel = getActivityLevel(stats);
  const bandState = getBandState(stats);
  const portableType = getPortableType(representative.tags);
  const signals = buildSignals(stats, representative, modeSummary, portableType);
  const why = buildWhy(stats, representative, solar, modeSummary, portableType);

  return {
    id: `${stats.bandKey}:${representative.spottedCallsign}`,
    callsign: representative.spottedCallsign,
    entity,
    band: representative.band,
    frequencyKHz: representative.frequencyKHz,
    frequencyMhz: formatFrequencyMhz(representative.frequencyKHz),
    summary: buildCardSummary(stats),
    countryCode: representative.countryCode,
    direction: pathEstimate ? getDirectionLabel(pathEstimate.direction) : undefined,
    bearing: pathEstimate ? pathEstimate.bearingDegrees : undefined,
    beamHeading: pathEstimate ? pathEstimate.bearingDegrees : stats.propagationBeamHeading ?? undefined,
    directionConfidence: stats.propagationDirectionConfidence,
    region: stats.roughRegionLabel ?? undefined,
    confidence: stats.confidence,
    confidenceReason: getConfidenceReason(stats, solar),
    activityLevel,
    bandState,
    freshnessSeconds,
    actionLine: buildActionLine(stats, representative, pathEstimate, modeSummary, portableType),
    signals,
    why,
    modeSummary,
    distanceKm: pathEstimate ? Math.round(pathEstimate.distanceKm) : undefined,
    trendLabel: getTrendLabel(stats),
    portable: portableType !== undefined,
    portableType,
    regional: pathEstimate ? pathEstimate.distanceKm <= 1500 : undefined,
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
  if (left.propagationDirectionConfidence !== right.propagationDirectionConfidence) {
    return compareDirectionConfidence(right.propagationDirectionConfidence) - compareDirectionConfidence(left.propagationDirectionConfidence);
  }

  if (left.predictedBandState !== right.predictedBandState) {
    return comparePredictedBandState(right.predictedBandState) - comparePredictedBandState(left.predictedBandState);
  }

  if (right.predictedBandScore !== left.predictedBandScore) {
    return right.predictedBandScore - left.predictedBandScore;
  }

  const leftIncreasing = left.activityTrend > 0 || left.pskTrendRising ? 1 : 0;
  const rightIncreasing = right.activityTrend > 0 || right.pskTrendRising ? 1 : 0;

  if (rightIncreasing !== leftIncreasing) {
    return rightIncreasing - leftIncreasing;
  }

  if (right.pskTrendRising !== left.pskTrendRising) {
    return Number(right.pskTrendRising) - Number(left.pskTrendRising);
  }

  if (right.pskCurrent !== left.pskCurrent) {
    return right.pskCurrent - left.pskCurrent;
  }

  if (left.pskTrendLabel !== right.pskTrendLabel) {
    return compareTrendLabel(right.pskTrendLabel) - compareTrendLabel(left.pskTrendLabel);
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

function getRepresentativePathEstimate(
  representative: StoredOpportunitySpot,
  homeGrid: string | undefined,
): PathEstimate | undefined {
  if (!homeGrid) {
    return undefined;
  }

  const dxLocator = normalizeHomeGrid(representative.dxLocator);

  if (!dxLocator) {
    return undefined;
  }

  return estimatePathBetweenLocators(homeGrid, dxLocator);
}

function buildDxCandidates(
  statsByBand: readonly BandStats[],
  homeContinent: string | null,
  homeGrid: string | undefined,
  dxRarity: DxRarityContext | null,
  solar: SolarConditions | null,
): readonly DxCandidate[] {
  return statsByBand
    .flatMap((stats) => buildBandDxCandidates(stats, homeContinent, homeGrid, dxRarity, solar))
    .sort((left, right) => {
      if (right.dxScore !== left.dxScore) {
        return right.dxScore - left.dxScore;
      }

      if (right.rarityScore !== left.rarityScore) {
        return right.rarityScore - left.rarityScore;
      }

      return right.card.score - left.card.score;
    });
}

function selectDxOpportunityCard(
  candidates: readonly DxCandidate[],
  bestOpportunity: OpportunityCard | null,
  fallback: OpportunityCard | null,
): OpportunityCard | null {
  for (const candidate of candidates) {
    if (!isDuplicateOpportunity(candidate.card, bestOpportunity) || candidate.rarityScore >= 0.7) {
      return candidate.card;
    }
  }

  return fallback;
}

function buildBandDxCandidates(
  stats: BandStats,
  homeContinent: string | null,
  homeGrid?: string,
  dxRarity?: DxRarityContext | null,
  solar?: SolarConditions | null,
): readonly DxCandidate[] {
  const latestByCallsign = new Map<string, StoredOpportunitySpot>();

  for (const spot of stats.spots) {
    const existing = latestByCallsign.get(spot.spottedCallsign);

    if (!existing || getSpotSortTime(spot) > getSpotSortTime(existing)) {
      latestByCallsign.set(spot.spottedCallsign, spot);
    }
  }

  return [...latestByCallsign.values()].map((representative) => {
    const entity = representative.countryCode ?? representative.continentDx;
    const activityScore = scoreDxActivity(stats, representative);
    const pathScore = scoreDxPath(stats, representative, homeContinent, homeGrid);
      const solarScore = scoreDxSolar(stats.bandKey, solar ?? null);
    const scored = scoreDxCandidate(
      {
        callsign: representative.spottedCallsign,
        entity,
        activityScore,
        pathScore,
        solarScore,
      },
      dxRarity,
    );
    const baseCard = createOpportunityCard(stats, representative, homeGrid);

    return {
      card: {
        ...baseCard,
        summary: `${baseCard.summary}, ${buildDxReasonSummary(representative.spottedCallsign, entity, scored.rarityScore, activityScore)}`,
        score: Math.round(baseCard.score + scored.dxScore * 100),
      },
      entity,
      activityScore: scored.activityScore,
      rarityScore: scored.rarityScore,
      pathScore: scored.pathScore,
      solarScore: scored.solarScore,
      dxScore: scored.dxScore,
    };
  });
}

function compareDxBandStats(
  left: BandStats,
  right: BandStats,
  leftCard: OpportunityCard,
  rightCard: OpportunityCard,
  operatingStyle: "dx" | undefined,
): number {
  if (left.propagationDirectionConfidence !== right.propagationDirectionConfidence) {
    return compareDirectionConfidence(right.propagationDirectionConfidence) - compareDirectionConfidence(left.propagationDirectionConfidence);
  }

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

function scoreDxActivity(
  stats: BandStats,
  representative: StoredOpportunitySpot,
): number {
  const callSpotCount = stats.spots.filter((spot) =>
    spot.spottedCallsign === representative.spottedCallsign
  ).length;

  return clamp01((callSpotCount / 3) * 0.65 + (stats.uniqueCallsigns / 10) * 0.35);
}

function scoreDxPath(
  stats: BandStats,
  representative: StoredOpportunitySpot,
  homeContinent: string | null,
  homeGrid: string | undefined,
): number {
  let score = 0.2;
  const representativeContinent = normalizeContinent(representative.continentDx);
  const pathEstimate = getRepresentativePathEstimate(representative, homeGrid);

  if (homeContinent && representativeContinent && representativeContinent !== homeContinent) {
    score += 0.4;
  }

  if (pathEstimate) {
    score += 0.25;

    if (pathEstimate.distanceKm >= 5000) {
      score += 0.1;
    }
  }

  if (stats.pskCurrent >= 20) {
    score += 0.05;
  }

  return clamp01(score);
}

function scoreDxSolar(bandKey: string, solar: SolarConditions | null): number {
  const muf = getSolarMuf(solar);
  const sfi = typeof solar?.sfi === "number" ? solar.sfi : null;
  let score = 0.35;

  if (bandKey === "10m" && muf !== null && muf >= 28) {
    score += 0.45;
  } else if (bandKey === "15m" && muf !== null && muf >= 21) {
    score += 0.4;
  } else if (bandKey === "17m" && muf !== null && muf >= 18) {
    score += 0.35;
  } else if (bandKey === "20m") {
    score += 0.2;
  }

  if (sfi !== null) {
    if (sfi >= 150 && (bandKey === "10m" || bandKey === "12m" || bandKey === "15m")) {
      score += 0.2;
    } else if (sfi >= 110) {
      score += 0.1;
    }
  }

  return clamp01(score);
}

function buildDxReasonSummary(
  callsign: string,
  entity: string | undefined,
  rarityScore: number,
  activityScore: number,
): string {
  if (rarityScore >= 0.85 && entity) {
    return "Rare entity active now";
  }

  if (rarityScore >= 0.7) {
    return "Currently workable DX with low recent appearance rate";
  }

  if (activityScore >= 0.65) {
    return "Uncommon callsign with multiple fresh spots";
  }

  return `${callsign} active now`;
}

function withCardType(
  card: OpportunityCard,
  cardType: OpportunityCard["cardType"],
): OpportunityCard {
  return {
    ...card,
    cardType,
  };
}

function getModeSummary(
  stats: BandStats,
  representative: StoredOpportunitySpot,
): string {
  const hasFt8 = representative.tags.includes("FT8") || representative.mode === "ft8";
  const hasFt4 = representative.tags.includes("FT4") || representative.mode === "ft4";
  const activeModes = countActiveModeFamilies(stats.modeFamilyCounts);

  if (stats.dominantModeFamily === "digital") {
    if (hasFt8 && hasFt4) {
      return "FT8/FT4 strong";
    }

    if (hasFt8) {
      return "FT8 strong";
    }

    if (hasFt4) {
      return "FT4 active";
    }

    return "Digital modes active";
  }

  if (stats.dominantModeFamily === "phone") {
    return "SSB likely good";
  }

  if (stats.dominantModeFamily === "cw") {
    return "CW possible";
  }

  if (activeModes >= 2) {
    return "Mixed mode opportunity";
  }

  return "Mixed signals";
}

function getActivityLevel(stats: BandStats): "High" | "Moderate" | "Low" {
  if (stats.totalSpots >= 12 || stats.uniqueCallsigns >= 8 || stats.pskCurrent >= 80) {
    return "High";
  }

  if (stats.totalSpots >= 5 || stats.uniqueCallsigns >= 4 || stats.pskCurrent >= 25) {
    return "Moderate";
  }

  return "Low";
}

function getBandState(stats: BandStats): "Opening" | "Stable" | "Fading" {
  if (stats.predictedBandState === "opening") {
    return "Opening";
  }

  if (stats.predictedBandState === "fading") {
    return "Fading";
  }

  if (stats.pskTrendLabel === "rising" || stats.activityTrend > 0) {
    return "Opening";
  }

  if (stats.pskTrendLabel === "falling" || stats.activityTrend < 0) {
    return "Fading";
  }

  return "Stable";
}

function getTrendLabel(stats: BandStats): "Rising" | "Steady" | "Falling" {
  if (stats.predictedBandState === "opening") {
    return "Rising";
  }

  if (stats.predictedBandState === "fading") {
    return "Falling";
  }

  if (stats.pskTrendLabel === "rising") {
    return "Rising";
  }

  if (stats.pskTrendLabel === "falling") {
    return "Falling";
  }

  return "Steady";
}

function getFreshnessSeconds(
  representative: StoredOpportunitySpot,
  now: number,
): number {
  return Math.max(0, Math.round((now - getSpotSortTime(representative)) / 1000));
}

function buildSignals(
  stats: BandStats,
  representative: StoredOpportunitySpot,
  modeSummary: string,
  portableType: "SOTA" | "POTA" | "Portable" | undefined,
): readonly string[] {
  const signals: string[] = [];

  signals.push(
    stats.totalSpots >= 10 || stats.uniqueCallsigns >= 7
      ? "Cluster strong"
      : stats.totalSpots >= 4
        ? "Cluster active"
        : "Cluster light",
  );

  if (stats.pskTrendLabel === "rising") {
    signals.push("PSK rising");
  } else if (stats.pskCurrent > 0) {
    signals.push("PSK steady");
  }

  for (const signal of stats.predictorSignals) {
    if (!signals.includes(signal)) {
      signals.push(signal);
    }
  }

  for (const signal of stats.propagationSignals) {
    if (!signals.includes(signal)) {
      signals.push(signal);
    }
  }

  if (stats.dominantDirection) {
    signals.push(`${toShortDirection(stats.dominantDirection)} opening`);
  }

  signals.push(modeSummary);

  if (portableType) {
    signals.push(portableType === "Portable" ? "Portable nearby" : `${portableType} nearby`);
  }

  if (representative.countryCode && representative.countryCode !== "US" && representative.countryCode !== "IE") {
    signals.push("Rare DX active");
  }

  return signals.slice(0, 5);
}

function buildWhy(
  stats: BandStats,
  representative: StoredOpportunitySpot,
  solar: SolarConditions | null,
  modeSummary: string,
  portableType: "SOTA" | "POTA" | "Portable" | undefined,
): readonly string[] {
  const why = [
    `${stats.totalSpots} recent spots`,
    `${stats.uniqueCallsigns} unique calls`,
  ];

  if (stats.pskCurrent >= 20) {
    why.push("PSK confirms activity");
  }

  if (stats.dominantDirection) {
    why.push(`Opening to ${stats.dominantDirection}`);
  }

  const muf = getSolarMuf(solar);
  if (muf !== null && representative.band && bandLooksSupportedByMuf(representative.band, muf)) {
    why.push(`MUF supports ${representative.band}`);
  }

  if (portableType) {
    why.push(
      portableType === "Portable"
        ? "Portable station in range"
        : `${portableType} station in range`,
    );
  } else {
    why.push(modeSummary);
  }

  return why.slice(0, 5);
}

function getConfidenceReason(
  stats: BandStats,
  solar: SolarConditions | null,
): string {
  const muf = getSolarMuf(solar);

  if (stats.propagationDirectionConfidence === "High" && stats.pskCurrent >= 20) {
    return "Cluster + PSK path agree";
  }

  if (stats.pskCurrent >= 20 && stats.totalSpots >= 8) {
    return "Cluster + PSK agree";
  }

  if (muf !== null && bandLooksSupportedByMuf(stats.bandKey, muf) && stats.totalSpots >= 5) {
    return "Solar and spot activity align";
  }

  if (stats.totalSpots >= 5) {
    return "Activity good, path less certain";
  }

  return "Fresh spots but limited PSK support";
}

function buildActionLine(
  stats: BandStats,
  representative: StoredOpportunitySpot,
  pathEstimate: PathEstimate | undefined,
  modeSummary: string,
  portableType: "SOTA" | "POTA" | "Portable" | undefined,
): string {
  const band = representative.band ?? stats.bandKey;
  const frequency = formatFrequencyMhz(representative.frequencyKHz);
  const direction = pathEstimate ? toShortDirection(getDirectionLabel(pathEstimate.direction)) : null;

  if (portableType) {
    return `Listen for nearby ${portableType.toLowerCase()} activity on ${band}`;
  }

  if (direction && pathEstimate) {
    return `Point beam ${direction} and listen around ${frequency}`;
  }

  if (direction) {
    return `Try ${band} to the ${getDirectionLabel(pathEstimate?.direction ?? stats.dominantDirectionBucket ?? "E")} now`;
  }

  if (modeSummary.startsWith("SSB")) {
    return `Listen around ${frequency} for SSB activity`;
  }

  return `Check ${band} around ${frequency} now`;
}

function getPortableType(
  tags: readonly ParsedSpot["tags"][number][],
): "SOTA" | "POTA" | "Portable" | undefined {
  if (tags.includes("SOTA")) {
    return "SOTA";
  }

  if (tags.includes("POTA")) {
    return "POTA";
  }

  if (tags.includes("WWFF") || tags.includes("/P")) {
    return "Portable";
  }

  return undefined;
}

function formatFrequencyMhz(frequencyKHz: number): string {
  return `${(frequencyKHz / 1000).toFixed(3)} MHz`;
}

function getEntityName(countryCode: string | undefined): string | undefined {
  if (!countryCode) {
    return undefined;
  }

  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode.toUpperCase()) ?? countryCode.toUpperCase();
  } catch {
    return countryCode.toUpperCase();
  }
}

function toShortDirection(direction: string): string {
  const labels: Record<string, string> = {
    North: "N",
    "North-East": "NE",
    East: "E",
    "South-East": "SE",
    South: "S",
    "South-West": "SW",
    West: "W",
    "North-West": "NW",
  };

  return labels[direction] ?? direction;
}

function bandLooksSupportedByMuf(bandKey: string, muf: number): boolean {
  if (bandKey === "10m") {
    return muf >= 28;
  }

  if (bandKey === "15m") {
    return muf >= 21;
  }

  if (bandKey === "17m") {
    return muf >= 18;
  }

  if (bandKey === "20m") {
    return muf >= 14;
  }

  return true;
}

function buildPropagationSignals(
  density: PropagationDensityMap[keyof PropagationDensityMap] | null,
): readonly string[] {
  if (!density || !density.dominantDirection) {
    return [];
  }

  const signals: string[] = [];
  const label = density.sector ?? density.dominantDirection;

  if (density.confidence === "High") {
    signals.push(`${label} propagation strongest`);
  } else if (density.confidence === "Medium") {
    signals.push(`${label} paths building`);
  } else {
    signals.push(`${label} signals spreading`);
  }

  return signals;
}

function isDuplicateOpportunity(
  left: OpportunityCard,
  right: OpportunityCard | null,
): boolean {
  if (!right) {
    return false;
  }

  if (left.callsign !== right.callsign) {
    return false;
  }

  if (left.band !== right.band) {
    return false;
  }

  return Math.abs(left.frequencyKHz - right.frequencyKHz) <= 10;
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

  if (stats.pskTrendLabel === "rising") {
    summaryParts.push(
      stats.pskTrendConfidence === "High"
        ? `${stats.bandKey} activity rising`
        : `${stats.bandKey} digital grids increasing`,
    );
  } else if (stats.pskTrendLabel === "falling") {
    summaryParts.push(`${stats.bandKey} stable but no longer rising`);
  }

  return summaryParts.join(", ");
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
  score += getPropagationScoreBoost(stats);
  score += countActiveModeFamilies(stats.modeFamilyCounts) * 12;
  score += getPskScoreBoost(stats);

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

function getPropagationScoreBoost(stats: BandStats): number {
  let score = 0;

  if (stats.propagationDirectionConfidence === "High") {
    score += 24;
  } else if (stats.propagationDirectionConfidence === "Medium") {
    score += 12;
  }

  if (stats.propagationSector) {
    score += 10;
  }

  return score;
}

function getPskScoreBoost(stats: BandStats): number {
  let score = 0;

  if (stats.pskBandBoostApplied) {
    score += 18;
  }

  if (stats.pskTrendRising) {
    score += 12;
  }

  if (stats.pskTrendLabel === "rising") {
    score += 10;
  } else if (stats.pskTrendLabel === "falling") {
    score -= 14;
  }

  if (stats.pskModeBoostApplied) {
    score += 8;
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

interface PskBandSummary {
  readonly current: number;
  readonly previous: number;
  readonly rising: boolean;
  readonly modeCounts: Readonly<Record<string, number>>;
}

interface DxCandidate {
  readonly card: OpportunityCard;
  readonly entity?: string;
  readonly activityScore: number;
  readonly rarityScore: number;
  readonly pathScore: number;
  readonly solarScore: number;
  readonly dxScore: number;
}

function indexPskSummaryByBand(
  summary: PskReporterSummary | null | undefined,
): ReadonlyMap<string, PskBandSummary> {
  const map = new Map<string, PskBandSummary>();

  if (!summary) {
    return map;
  }

  for (const band of summary.bands) {
    const bandKey = band.band ?? "unknown";
    map.set(bandKey, {
      current: band.currentWindowCount,
      previous: band.previousWindowCount,
      rising: band.previousWindowCount > 0
        ? band.currentWindowCount > band.previousWindowCount * 1.2
        : band.currentWindowCount >= 10,
      modeCounts: band.modeCounts,
    });
  }

  return map;
}

function emptyPskBandSummary(): PskBandSummary {
  return {
    current: 0,
    previous: 0,
    rising: false,
    modeCounts: {},
  };
}

function compareTrendLabel(value: "rising" | "steady" | "falling"): number {
  if (value === "rising") {
    return 2;
  }

  if (value === "steady") {
    return 1;
  }

  return 0;
}

function comparePredictedBandState(value: "opening" | "stable" | "fading"): number {
  if (value === "opening") {
    return 2;
  }

  if (value === "stable") {
    return 1;
  }

  return 0;
}

function compareDirectionConfidence(value: "High" | "Medium" | "Low"): number {
  if (value === "High") {
    return 2;
  }

  if (value === "Medium") {
    return 1;
  }

  return 0;
}

function shouldApplyPskModeBoost(
  modeCounts: Readonly<Record<string, number>>,
  dominantModeFamily: ModeFamilyKey,
): boolean {
  if (dominantModeFamily !== "digital") {
    return false;
  }

  const digitalCount = (modeCounts.FT8 ?? 0) + (modeCounts.FT4 ?? 0) + (modeCounts.DIGITAL ?? 0);
  return digitalCount >= 20;
}

function roundDebugScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function getSolarMuf(solar: SolarConditions | null): number | null {
  if (typeof solar?.muf === "number" && Number.isFinite(solar.muf)) {
    return solar.muf;
  }

  if (typeof solar?.muf === "string") {
    const parsed = Number.parseFloat(solar.muf);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
