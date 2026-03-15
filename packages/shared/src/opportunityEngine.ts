import type { Band } from "./bands.js";
import { predictAllBands } from "./bandPredictor.js";
import { detectDxEvents, type DxEventCandidate } from "./dxEvents.js";
import { getAllBandPathDensities } from "./pathDensity.js";
import {
  deriveContinentFromMaidenhead,
  estimatePathBetweenLocators,
  parseMaidenheadLocator,
} from "./maidenhead.js";
import {
  parseStoredOpportunitySpot,
  type StoredOpportunitySpot,
} from "./opportunities.js";
import type {
  BandPrediction,
  BandPredictionMap,
  PropagationBandDensity,
  PropagationDensityMap,
  PskReporterSummary,
  SolarConditions,
  SpotTag,
} from "./types.js";

const RECENT_WINDOW_MS = 15 * 60 * 1000;
const DISTANCE_NEARBY_KM = 1_500;
const supportedBands: readonly Band[] = [
  "160m",
  "80m",
  "60m",
  "40m",
  "30m",
  "20m",
  "17m",
  "15m",
  "12m",
  "10m",
  "6m",
  "2m",
];
const directionOrder = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const directionCenterDegrees: Record<(typeof directionOrder)[number], number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

export interface RadioPilotUserProfile {
  readonly homeGrid: string;
  readonly homeContinent: string;
  readonly operatingStyle: "DX" | "casual" | "digital";
  readonly modePreference: readonly string[];
  readonly bandsAvailable: readonly string[];
  readonly antennaType: "beam" | "dipole" | "vertical";
}

export interface OpportunityEngineCard {
  readonly band: string;
  readonly mode: string;
  readonly direction: string;
  readonly beamHeading: number;
  readonly confidence: "High" | "Medium" | "Low";
  readonly directionConfidence?: "High" | "Medium" | "Low";
  readonly dxEventType?: string;
  readonly rarityScore?: number;
  readonly bandState?: "Opening" | "Stable" | "Fading";
  readonly trendLabel?: "Rising" | "Steady" | "Falling";
  readonly signals?: readonly string[];
  readonly why?: readonly string[];
  readonly actionLine?: string;
  readonly callsign?: string;
  readonly frequency?: number;
  readonly entity?: string;
  readonly reason: readonly string[];
}

export interface OpportunityEngineResult {
  readonly bestOpportunity: OpportunityEngineCard | null;
  readonly watchNext: OpportunityEngineCard | null;
  readonly dxOpportunity: OpportunityEngineCard | null;
  readonly nearbyActivity: OpportunityEngineCard | null;
}

export interface OpportunityRedisClient {
  get(key: string): Promise<string | null>;
  zRangeByScore(key: string, min: number, max: number): Promise<string[]>;
  hGet?(key: string, field: string): Promise<string | null>;
}

interface CandidateEvidence {
  readonly band: Band;
  readonly representative: StoredOpportunitySpot;
  readonly mode: string;
  readonly direction: (typeof directionOrder)[number];
  readonly beamHeading: number;
  readonly entity?: string;
  readonly callsign?: string;
  readonly frequency?: number;
  readonly activityScore: number;
  readonly pathScore: number;
  readonly trendScore: number;
  readonly modeFitScore: number;
  readonly solarScore: number;
  readonly rarityScore: number;
  readonly userPreferenceScore: number;
  readonly totalScore: number;
  readonly confidence: "High" | "Medium" | "Low";
  readonly reason: readonly string[];
  readonly signals: readonly string[];
  readonly why: readonly string[];
  readonly actionLine?: string;
  readonly bandState: "Opening" | "Stable" | "Fading";
  readonly trendLabel: "Rising" | "Steady" | "Falling";
  readonly directionConfidence: "High" | "Medium" | "Low";
  readonly dxEventType?: string;
  readonly offContinent: boolean;
  readonly portable: boolean;
  readonly nearbyDistanceKm?: number;
}

interface BandContext {
  readonly band: Band;
  readonly currentSpots: readonly StoredOpportunitySpot[];
  readonly previousSpots: readonly StoredOpportunitySpot[];
  readonly pskCurrent: number;
  readonly pskPrevious: number;
  readonly pskModeCounts: Readonly<Record<string, number>>;
  readonly pskDirectionCounts: Readonly<Record<(typeof directionOrder)[number], number>>;
  readonly bandPrediction: BandPrediction | null;
  readonly pathDensity: PropagationBandDensity | null;
}

interface LoadedRedisState {
  readonly spots: readonly StoredOpportunitySpot[];
  readonly pskSummary: PskReporterSummary | null;
  readonly pskDirectionalCounts: ReadonlyMap<Band, Readonly<Record<(typeof directionOrder)[number], number>>>;
  readonly solar: SolarConditions | null;
  readonly bandPredictions: BandPredictionMap;
  readonly pathDensities: PropagationDensityMap;
}

interface NormalizedUserProfile {
  readonly homeGrid: string;
  readonly homeContinent: string;
  readonly operatingStyle: "dx" | "casual" | "digital";
  readonly modePreference: readonly string[];
  readonly bandsAvailable: readonly string[];
  readonly antennaType: "beam" | "dipole" | "vertical";
}

export async function generateOpportunities(
  userProfile: RadioPilotUserProfile,
  redisClient: OpportunityRedisClient,
): Promise<OpportunityEngineResult> {
  const normalizedProfile = normalizeUserProfile(userProfile);
  const state = await loadRedisState(redisClient);
  const now = Date.now();
  const currentWindowStart = now - RECENT_WINDOW_MS;
  const previousWindowStart = now - RECENT_WINDOW_MS * 2;
  const currentSpots = state.spots.filter((spot) => {
    const observedAt = getSpotTimestamp(spot);
    return observedAt >= currentWindowStart && observedAt <= now;
  });
  const previousSpots = state.spots.filter((spot) => {
    const observedAt = getSpotTimestamp(spot);
    return observedAt >= previousWindowStart && observedAt < currentWindowStart;
  });
  const dxEvents = await loadDxEvents(currentSpots, redisClient, now);
  const dxEventsByCallsign = new Map(dxEvents.map((event) => [event.callsign, event] as const));
  const candidates = supportedBands
    .map((band) => buildBandCandidate(
      band,
      currentSpots,
      previousSpots,
      state,
      normalizedProfile,
      dxEventsByCallsign,
    ))
    .flatMap((candidate) => candidate ? [candidate] : [])
    .sort((left, right) => right.totalScore - left.totalScore);

  const bestCandidate = candidates[0] ?? null;

  return {
    bestOpportunity: toCard(bestCandidate),
    watchNext: toCard(selectWatchNext(candidates, bestCandidate)),
    dxOpportunity: toCard(selectDxOpportunity(candidates, bestCandidate, normalizedProfile)),
    nearbyActivity: toCard(selectNearbyActivity(currentSpots, normalizedProfile, state.solar)),
  };
}

async function loadRedisState(redisClient: OpportunityRedisClient): Promise<LoadedRedisState> {
  const now = Date.now();
  const [
    rawSpots,
    rawPskSummary,
    rawPskFreshness,
    rawSolarCurrent,
    rawSolarLatest,
    bandPredictions,
    pathDensities,
  ] = await Promise.all([
    redisClient.zRangeByScore("spots:recent", now - RECENT_WINDOW_MS * 2, now),
    redisClient.get("psk:summary"),
    redisClient.get("psk:freshness"),
    redisClient.get("solar:current"),
    redisClient.get("solar:latest"),
    predictAllBands(redisClient),
    getAllBandPathDensities(redisClient),
  ]);

  return {
    spots: rawSpots.flatMap(parseStoredOpportunitySpot),
    pskSummary: parseFreshPskSummary(rawPskSummary, rawPskFreshness),
    pskDirectionalCounts: await loadDirectionalCounts(redisClient),
    solar: parseSolar(rawSolarCurrent) ?? parseSolar(rawSolarLatest),
    bandPredictions,
    pathDensities,
  };
}

async function loadDxEvents(
  spots: readonly StoredOpportunitySpot[],
  redisClient: OpportunityRedisClient,
  now: number,
): Promise<readonly DxEventCandidate[]> {
  if (typeof redisClient.hGet !== "function") {
    return [];
  }

  return detectDxEvents(spots, {
    hGet: redisClient.hGet.bind(redisClient),
    async hIncrBy() {
      return 0;
    },
    async expire() {
      return 1;
    },
  }, now);
}

async function loadDirectionalCounts(
  redisClient: OpportunityRedisClient,
): Promise<ReadonlyMap<Band, Readonly<Record<(typeof directionOrder)[number], number>>>> {
  const lookups = supportedBands.flatMap((band) =>
    directionOrder.map((direction) => ({
      band,
      direction,
      key: `psk:band:${band}:dir:${direction}`,
    })));
  const values = await Promise.all(lookups.map((entry) => redisClient.get(entry.key)));
  const counts = new Map<Band, Record<(typeof directionOrder)[number], number>>();

  for (const band of supportedBands) {
    counts.set(band, emptyDirectionCounts());
  }

  lookups.forEach((entry, index) => {
    const numericValue = Number.parseInt(values[index] ?? "0", 10);

    if (Number.isFinite(numericValue)) {
      counts.get(entry.band)![entry.direction] = numericValue;
    }
  });

  return counts;
}

function buildBandCandidate(
  band: Band,
  currentSpots: readonly StoredOpportunitySpot[],
  previousSpots: readonly StoredOpportunitySpot[],
  state: LoadedRedisState,
  userProfile: NormalizedUserProfile,
  dxEventsByCallsign: ReadonlyMap<string, DxEventCandidate>,
): CandidateEvidence | null {
  const currentBandSpots = currentSpots.filter((spot) => spot.band === band);
  const previousBandSpots = previousSpots.filter((spot) => spot.band === band);
  const pskBand = state.pskSummary?.bands.find((entry) => entry.band === band) ?? null;

  if (currentBandSpots.length === 0 && !pskBand) {
    return null;
  }

  const representative = selectRepresentativeSpot(currentBandSpots);

  if (!representative) {
    return null;
  }

  const context: BandContext = {
    band,
    currentSpots: currentBandSpots,
    previousSpots: previousBandSpots,
    pskCurrent: pskBand?.currentWindowCount ?? 0,
    pskPrevious: pskBand?.previousWindowCount ?? 0,
    pskModeCounts: pskBand?.modeCounts ?? {},
    pskDirectionCounts: state.pskDirectionalCounts.get(band) ?? emptyDirectionCounts(),
    bandPrediction: state.bandPredictions[band] ?? null,
    pathDensity: state.pathDensities[band] ?? null,
  };
  const direction = inferDirection(userProfile.homeGrid, representative, context);
  const beamHeading = inferBeamHeading(userProfile.homeGrid, representative, direction, context);
  const mode = inferMode(representative, context, userProfile.modePreference);
  const offContinent = isOffContinent(representative, userProfile.homeContinent);
  const dxEvent = dxEventsByCallsign.get(representative.spottedCallsign.trim().toUpperCase());
  const activityScore = scoreActivity(context);
  const pathScore = scorePath(context, representative, userProfile, direction);
  const trendScore = scoreTrend(context);
  const modeFitScore = scoreModeFit(mode, context, userProfile);
  const solarScore = scoreSolar(band, state.solar);
  const rarityScore = scoreRarity(representative, currentSpots, offContinent);
  const userPreferenceScore = scoreUserPreference(band, mode, userProfile);
  const totalScore =
    0.28 * activityScore +
    0.22 * pathScore +
    0.14 * trendScore +
    0.12 * modeFitScore +
    0.10 * solarScore +
    0.08 * rarityScore +
    0.06 * userPreferenceScore;

  return {
    band,
    representative,
    mode,
    direction,
    beamHeading,
    entity: getEntityName(representative.countryCode),
    callsign: representative.spottedCallsign,
    frequency: representative.frequencyKHz,
    activityScore,
    pathScore,
    trendScore,
    modeFitScore,
    solarScore,
    rarityScore,
    userPreferenceScore,
    totalScore,
    confidence: deriveConfidence(activityScore, pathScore, trendScore, solarScore, context),
    reason: buildReasonList(context, representative, mode, direction, offContinent, state.solar, userProfile),
    signals: buildSignals(context, representative, mode, direction, dxEvent),
    why: buildWhy(context, representative, mode, offContinent, state.solar, dxEvent),
    actionLine: buildDxActionLine(band, direction, beamHeading, representative.frequencyKHz, dxEvent),
    bandState: toBandState(context.bandPrediction),
    trendLabel: toTrendLabel(context.bandPrediction, context),
    directionConfidence: context.pathDensity?.confidence ?? "Low",
    dxEventType: dxEvent?.eventType,
    offContinent,
    portable: isPortable(representative.tags),
  };
}

function selectWatchNext(
  candidates: readonly CandidateEvidence[],
  bestCandidate: CandidateEvidence | null,
): CandidateEvidence | null {
  return candidates
    .filter((candidate) => candidate.band !== bestCandidate?.band)
    .sort((left, right) => {
      const leftWatchScore = scoreWatchNextCandidate(left, bestCandidate);
      const rightWatchScore = scoreWatchNextCandidate(right, bestCandidate);

      if (rightWatchScore !== leftWatchScore) {
        return rightWatchScore - leftWatchScore;
      }

      if (right.trendScore !== left.trendScore) {
        return right.trendScore - left.trendScore;
      }

      return right.totalScore - left.totalScore;
    })[0] ?? null;
}

function selectDxOpportunity(
  candidates: readonly CandidateEvidence[],
  bestCandidate: CandidateEvidence | null,
  userProfile: NormalizedUserProfile,
): CandidateEvidence | null {
  const ranked = candidates
    .filter((candidate) => candidate.offContinent || candidate.rarityScore >= 45 || candidate.dxEventType)
    .sort((left, right) => {
      const leftDxScore = scoreDxOpportunityCandidate(left, userProfile);
      const rightDxScore = scoreDxOpportunityCandidate(right, userProfile);

      if (rightDxScore !== leftDxScore) {
        return rightDxScore - leftDxScore;
      }

      return right.totalScore - left.totalScore;
    });

  for (const candidate of ranked) {
    if (!isDuplicateDxCandidate(candidate, bestCandidate)) {
      return candidate;
    }
  }

  return ranked[0] ?? candidates.find((candidate) => candidate.band !== bestCandidate?.band) ?? null;
}

function selectNearbyActivity(
  currentSpots: readonly StoredOpportunitySpot[],
  userProfile: NormalizedUserProfile,
  solar: SolarConditions | null,
): CandidateEvidence | null {
  return currentSpots
    .flatMap((spot) => {
      const distanceKm = getDistanceKm(userProfile.homeGrid, spot.dxLocator);
      const portable = isPortable(spot.tags);

      if (!portable && (distanceKm === null || distanceKm > DISTANCE_NEARBY_KM)) {
        return [];
      }

      if (!spot.band) {
        return [];
      }

      const context: BandContext = {
        band: spot.band,
        currentSpots: [spot],
        previousSpots: [],
        pskCurrent: 0,
        pskPrevious: 0,
        pskModeCounts: {},
        pskDirectionCounts: emptyDirectionCounts(),
        bandPrediction: null,
        pathDensity: null,
      };
      const direction = inferDirection(userProfile.homeGrid, spot, context);
      const beamHeading = inferBeamHeading(userProfile.homeGrid, spot, direction, context);
      const mode = inferMode(spot, context, userProfile.modePreference);
      const activityScore = portable ? 82 : 56;
      const pathScore = distanceKm === null ? 35 : clamp(100 - (distanceKm / DISTANCE_NEARBY_KM) * 100, 0, 100);
      const trendScore = 30;
      const modeFitScore = scoreModeFit(mode, context, userProfile);
      const solarScore = scoreSolar(spot.band, solar);
      const rarityScore = portable ? 78 : 18;
      const userPreferenceScore = scoreUserPreference(spot.band, mode, userProfile);
      const totalScore =
        0.28 * activityScore +
        0.22 * pathScore +
        0.14 * trendScore +
        0.12 * modeFitScore +
        0.10 * solarScore +
        0.08 * rarityScore +
        0.06 * userPreferenceScore;

      return [{
        band: spot.band,
        representative: spot,
        mode,
        direction,
        beamHeading,
        entity: getEntityName(spot.countryCode),
        callsign: spot.spottedCallsign,
        frequency: spot.frequencyKHz,
        activityScore,
        pathScore,
        trendScore,
        modeFitScore,
        solarScore,
        rarityScore,
        userPreferenceScore,
        totalScore,
        confidence: deriveConfidence(activityScore, pathScore, trendScore, solarScore, context),
        reason: portable
          ? [
            `${spot.tags.find((tag) => isPortableTag(tag)) ?? "Portable"} activity detected`,
            distanceKm !== null ? `${Math.round(distanceKm)} km from station` : "Regional portable activity",
          ]
          : [
            distanceKm !== null ? `${Math.round(distanceKm)} km from station` : "Regional station",
            "Short-haul path currently active",
          ],
        signals: portable
          ? ["Portable nearby", `${spot.band} regional activity`]
          : [`${spot.band} regional activity`, "Nearby path active"],
        why: portable
          ? [
            `${spot.tags.find((tag) => isPortableTag(tag)) ?? "Portable"} activity detected`,
            distanceKm !== null ? `${Math.round(distanceKm)} km from station` : "Regional portable activity",
          ]
          : [
            distanceKm !== null ? `${Math.round(distanceKm)} km from station` : "Regional station",
            "Good fit for nearby work",
          ],
        actionLine: portable
          ? `Call nearby portable on ${spot.band}`
          : `Regional activity on ${spot.band}`,
        bandState: "Stable" as const,
        trendLabel: "Steady" as const,
        directionConfidence: "Low" as const,
        offContinent: false,
        portable,
        nearbyDistanceKm: distanceKm ?? undefined,
      }];
    })
    .sort((left, right) => right.totalScore - left.totalScore)[0] ?? null;
}

function toCard(candidate: CandidateEvidence | null): OpportunityEngineCard | null {
  if (!candidate) {
    return null;
  }

  return {
    band: candidate.band,
    mode: candidate.mode,
    direction: directionLabel(candidate.direction),
    beamHeading: candidate.beamHeading,
    confidence: candidate.confidence,
    directionConfidence: candidate.directionConfidence,
    dxEventType: candidate.dxEventType,
    rarityScore: roundScore(candidate.rarityScore / 100),
    bandState: candidate.bandState,
    trendLabel: candidate.trendLabel,
    signals: candidate.signals,
    why: candidate.why,
    actionLine: candidate.actionLine,
    callsign: candidate.callsign,
    frequency: candidate.frequency,
    entity: candidate.entity,
    reason: candidate.reason,
  };
}

function normalizeUserProfile(userProfile: RadioPilotUserProfile): NormalizedUserProfile {
  const normalizedHomeGrid = userProfile.homeGrid.trim().toUpperCase();
  const validHomeGrid = parseMaidenheadLocator(normalizedHomeGrid) ? normalizedHomeGrid : "";
  const derivedContinent = validHomeGrid ? deriveContinentFromMaidenhead(validHomeGrid) : undefined;

  return {
    homeGrid: validHomeGrid,
    homeContinent: (userProfile.homeContinent || derivedContinent || "").trim().toUpperCase(),
    operatingStyle: userProfile.operatingStyle.trim().toLowerCase() as NormalizedUserProfile["operatingStyle"],
    modePreference: userProfile.modePreference.map((mode) => mode.trim().toUpperCase()).filter(Boolean),
    bandsAvailable: userProfile.bandsAvailable.map((band) => band.trim()).filter(Boolean),
    antennaType: userProfile.antennaType,
  };
}

function parseFreshPskSummary(
  rawSummary: string | null,
  rawFreshness: string | null,
): PskReporterSummary | null {
  if (!rawSummary) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawSummary) as PskReporterSummary;

    if (!Array.isArray(parsed.bands)) {
      return null;
    }

    const freshness = rawFreshness ? Date.parse(rawFreshness) : Date.parse(parsed.freshnessTimestamp);
    return Number.isFinite(freshness) && freshness >= Date.now() - RECENT_WINDOW_MS * 2
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseSolar(rawValue: string | null): SolarConditions | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<SolarConditions>;
    return typeof parsed.updatedAt === "string"
      ? {
        sfi: typeof parsed.sfi === "number" ? parsed.sfi : undefined,
        kp: typeof parsed.kp === "number" ? parsed.kp : undefined,
        aIndex: typeof parsed.aIndex === "number" ? parsed.aIndex : undefined,
        muf: typeof parsed.muf === "number" || typeof parsed.muf === "string" ? parsed.muf : undefined,
        sunspots: typeof parsed.sunspots === "number" ? parsed.sunspots : undefined,
        updatedAt: parsed.updatedAt,
      }
      : null;
  } catch {
    return null;
  }
}

function scoreActivity(context: BandContext): number {
  const uniqueCallsigns = new Set(context.currentSpots.map((spot) => spot.spottedCallsign)).size;
  return clamp(context.currentSpots.length * 12 + uniqueCallsigns * 8 + context.pskCurrent * 0.6, 0, 100);
}

function scorePath(
  context: BandContext,
  representative: StoredOpportunitySpot,
  userProfile: NormalizedUserProfile,
  direction: (typeof directionOrder)[number],
): number {
  let score = 18 + Math.min(48, (context.pskDirectionCounts[direction] ?? 0) * 3);
  score += scorePathDensityAlignment(context, direction);

  if (userProfile.homeGrid && representative.dxLocator) {
    const path = estimatePathBetweenLocators(userProfile.homeGrid, representative.dxLocator);

    if (path) {
      score += 20;

      if (path.distanceKm > 4_000 && userProfile.operatingStyle === "dx") {
        score += 10;
      }
    }
  }

  if (isOffContinent(representative, userProfile.homeContinent)) {
    score += 12;
  }

  return clamp(score, 0, 100);
}

function scoreTrend(context: BandContext): number {
  const pskTrend = context.pskPrevious > 0
    ? ((context.pskCurrent - context.pskPrevious) / context.pskPrevious) * 100
    : context.pskCurrent > 0 ? 40 : 0;
  const spotTrend = context.currentSpots.length - context.previousSpots.length;
  const predictorBoost = context.bandPrediction?.state === "opening"
    ? 12
    : context.bandPrediction?.state === "fading"
      ? -14
      : 0;
  return clamp(40 + pskTrend * 0.5 + spotTrend * 6 + predictorBoost, 0, 100);
}

function scoreModeFit(
  mode: string,
  context: BandContext,
  userProfile: NormalizedUserProfile,
): number {
  let score = 40;

  if (userProfile.modePreference.includes(mode.toUpperCase())) {
    score += 35;
  }

  if (userProfile.operatingStyle === "digital" && (mode === "FT8" || mode === "FT4")) {
    score += 20;
  }

  if ((context.pskModeCounts[mode] ?? 0) >= 20) {
    score += 15;
  }

  return clamp(score, 0, 100);
}

function scoreSolar(band: Band, solar: SolarConditions | null): number {
  if (!solar) {
    return 40;
  }

  let score = 40 + clamp((solar.sfi ?? 100) - 100, -10, 20);
  const muf = normalizeSolarNumber(solar.muf);

  if (muf !== null) {
    if (band === "10m" && muf > 28) {
      score += 35;
    } else if (band === "15m" && muf > 21) {
      score += 30;
    } else if (band === "17m" && muf > 18) {
      score += 24;
    } else if (band === "20m" && muf > 14) {
      score += 18;
    }
  }

  if ((solar.kp ?? 3) <= 2) {
    score += 10;
  } else if ((solar.kp ?? 3) >= 5) {
    score -= 12;
  }

  return clamp(score, 0, 100);
}

function scoreRarity(
  representative: StoredOpportunitySpot,
  currentSpots: readonly StoredOpportunitySpot[],
  offContinent: boolean,
): number {
  const entityKey = representative.countryCode ?? representative.continentDx ?? representative.spottedCallsign;
  const mentions = currentSpots.filter((spot) =>
    (spot.countryCode ?? spot.continentDx ?? spot.spottedCallsign) === entityKey
  ).length;
  let score = offContinent ? 50 : 20;

  if (mentions <= 1) {
    score += 30;
  } else if (mentions <= 3) {
    score += 18;
  }

  return clamp(score, 0, 100);
}

function scoreUserPreference(
  band: Band,
  mode: string,
  userProfile: NormalizedUserProfile,
): number {
  let score = 35;

  if (userProfile.bandsAvailable.includes(band)) {
    score += 35;
  }

  if (userProfile.antennaType === "beam" && ["10m", "12m", "15m", "17m", "20m"].includes(band)) {
    score += 12;
  }

  if (userProfile.antennaType === "vertical" && ["30m", "40m"].includes(band)) {
    score += 10;
  }

  if (userProfile.modePreference.includes(mode.toUpperCase())) {
    score += 8;
  }

  return clamp(score, 0, 100);
}

function buildReasonList(
  context: BandContext,
  representative: StoredOpportunitySpot,
  mode: string,
  direction: (typeof directionOrder)[number],
  offContinent: boolean,
  solar: SolarConditions | null,
  userProfile: NormalizedUserProfile,
): readonly string[] {
  const reasons = [`${context.currentSpots.length} DXHeat spots on ${context.band}`];

  if (context.pskCurrent > 0) {
    reasons.push(`${context.pskCurrent} PSK reports confirm activity`);
  }

  if (context.pskPrevious > 0 && context.pskCurrent > context.pskPrevious * 1.2) {
    reasons.push("PSK trend is rising");
  }

  reasons.push(`${directionLabel(direction)} path is active`);

  if (offContinent) {
    reasons.push("Off-continent DX path detected");
  }

  if (solar) {
    const muf = normalizeSolarNumber(solar.muf);

    if (muf !== null) {
      reasons.push(`MUF ${muf.toFixed(1)} MHz supports ${context.band}`);
    }
  }

  if (userProfile.modePreference.includes(mode.toUpperCase())) {
    reasons.push(`${mode} matches your operating preference`);
  }

  if (representative.countryCode) {
    reasons.push(`${getEntityName(representative.countryCode) ?? representative.countryCode} spotted`);
  }

  return reasons;
}

function buildSignals(
  context: BandContext,
  representative: StoredOpportunitySpot,
  mode: string,
  direction: (typeof directionOrder)[number],
  dxEvent: DxEventCandidate | undefined,
): readonly string[] {
  const signals: string[] = [];

  if (context.currentSpots.length >= 6) {
    signals.push(`${context.band} cluster active`);
  }

  if (context.bandPrediction) {
    for (const signal of context.bandPrediction.signals) {
      if (!signals.includes(signal)) {
        signals.push(signal);
      }
    }
  }

  for (const signal of buildPathDensitySignals(context)) {
    if (!signals.includes(signal)) {
      signals.push(signal);
    }
  }

  if (context.pskCurrent > context.pskPrevious * 1.2 && context.pskCurrent > 0) {
    signals.push("PSK rising");
  } else if (context.pskCurrent > 0) {
    signals.push("PSK steady");
  }

  signals.push(`${directionLabel(direction)} path active`);

  if (mode === "FT8" || mode === "FT4") {
    signals.push(`${mode} supported`);
  } else if (mode === "SSB") {
    signals.push("SSB likely good");
  } else if (mode === "CW") {
    signals.push("CW possible");
  }

  if (isPortable(representative.tags)) {
    signals.push("Portable nearby");
  }

  if (dxEvent) {
    for (const signal of dxEvent.signals) {
      if (!signals.includes(signal)) {
        signals.push(signal);
      }
    }
  }

  return signals.slice(0, 5);
}

function buildWhy(
  context: BandContext,
  representative: StoredOpportunitySpot,
  mode: string,
  offContinent: boolean,
  solar: SolarConditions | null,
  dxEvent: DxEventCandidate | undefined,
): readonly string[] {
  const why = [`${context.currentSpots.length} recent spots on ${context.band}`];
  const uniqueCallsigns = new Set(context.currentSpots.map((spot) => spot.spottedCallsign)).size;
  why.push(`${uniqueCallsigns} unique calls`);

  if (context.pskCurrent > 0) {
    why.push(`${context.pskCurrent} PSK reports confirm activity`);
  }

  if (context.pathDensity?.direction && context.pathDensity.confidence !== "Low") {
    why.push(`${directionLabel(context.pathDensity.direction)} path density supports ${context.band}`);
  }

  if (context.bandPrediction?.state === "opening") {
    why.push(`${context.band} opening`);
  } else if (context.bandPrediction?.state === "fading") {
    why.push(`${context.band} fading`);
  }

  if (solar) {
    const muf = normalizeSolarNumber(solar.muf);

    if (muf !== null && representative.band && bandLooksSupportedByMuf(representative.band, muf)) {
      why.push(`Solar supports ${representative.band}`);
    }
  }

  if (offContinent) {
    why.push("Off-continent path active");
  } else if (mode === "FT8" || mode === "FT4") {
    why.push("Digital path supported");
  }

  if (dxEvent?.eventType) {
    why.push(dxEvent.eventType);
  }

  return why.slice(0, 5);
}

function buildDxActionLine(
  band: Band,
  direction: (typeof directionOrder)[number],
  beamHeading: number,
  frequencyKHz: number,
  dxEvent: DxEventCandidate | undefined,
): string {
  const shortDirection = shortDirectionLabel(direction);
  const frequencyMHz = (frequencyKHz / 1000).toFixed(3);

  if (dxEvent?.eventType === "Possible DXpedition") {
    return `Point beam ${shortDirection} and listen around ${frequencyMHz} MHz`;
  }

  if (dxEvent?.eventType === "Rare DX active") {
    return `Try rare DX on ${band} toward ${shortDirection}`;
  }

  return `Work ${band} toward ${shortDirection} (${Math.round(beamHeading)}°)`;
}

function deriveConfidence(
  activityScore: number,
  pathScore: number,
  trendScore: number,
  solarScore: number,
  context: BandContext,
): "High" | "Medium" | "Low" {
  let signals = 0;

  if (activityScore >= 60) {
    signals += 1;
  }

  if (pathScore >= 60) {
    signals += 1;
  }

  if (trendScore >= 55) {
    signals += 1;
  }

  if (solarScore >= 55) {
    signals += 1;
  }

  if (context.pskCurrent > 0 && context.currentSpots.length > 0) {
    signals += 1;
  }

  if (signals >= 4) {
    return "High";
  }

  if (signals >= 2) {
    return "Medium";
  }

  return "Low";
}

function scorePathDensityAlignment(
  context: BandContext,
  candidateDirection: (typeof directionOrder)[number],
): number {
  const density = context.pathDensity;

  if (!density?.direction || Object.keys(density.densities).length === 0) {
    return 0;
  }

  const dominantDirection = density.direction;
  const dominantDensity = density.densities[dominantDirection] ?? 0;
  const candidateDensity = density.densities[candidateDirection] ?? 0;

  if (candidateDirection === dominantDirection) {
    return density.confidence === "High" ? 22 : density.confidence === "Medium" ? 12 : 6;
  }

  if (density.sector?.includes(candidateDirection)) {
    return density.confidence === "High" ? 14 : 8;
  }

  if (density.confidence === "High" && dominantDensity >= 0.3 && candidateDensity <= 0.08) {
    return -10;
  }

  return 0;
}

function buildPathDensitySignals(context: BandContext): readonly string[] {
  const density = context.pathDensity;

  if (!density?.direction) {
    return [];
  }

  const direction = directionLabel(density.direction);

  if (density.confidence === "High") {
    return [`${direction} propagation strongest`];
  }

  if (density.confidence === "Medium") {
    return [`${direction} paths building`];
  }

  return [`${direction} propagation diffuse`];
}

function scoreWatchNextCandidate(
  candidate: CandidateEvidence,
  bestCandidate: CandidateEvidence | null,
): number {
  let score = candidate.totalScore * 0.35 + candidate.trendScore * 0.35;

  if (candidate.bandState === "Opening") {
    score += 35;
  } else if (candidate.bandState === "Fading") {
    score -= 24;
  }

  if (candidate.trendLabel === "Rising") {
    score += 18;
  } else if (candidate.trendLabel === "Falling") {
    score -= 12;
  }

  if (candidate.signals.includes("Digital grids increasing")) {
    score += 8;
  }

  if (candidate.signals.includes("Directional PSK support")) {
    score += 10;
  }

  if (candidate.directionConfidence === "High") {
    score += 14;
  } else if (candidate.directionConfidence === "Medium") {
    score += 6;
  }

  const clusterGap = bestCandidate ? Math.max(0, bestCandidate.activityScore - candidate.activityScore) : 0;
  score -= Math.min(18, clusterGap * 0.12);

  return score;
}

function scoreDxOpportunityCandidate(
  candidate: CandidateEvidence,
  userProfile: NormalizedUserProfile,
): number {
  const activityScore = candidate.activityScore / 100;
  const rarityScore = candidate.rarityScore / 100;
  const eventScore = scoreDxEventStrength(candidate);
  const pathScore = candidate.pathScore / 100;
  const solarScore = candidate.solarScore / 100;
  let score =
    0.28 * activityScore +
    0.28 * rarityScore +
    0.22 * eventScore +
    0.14 * pathScore +
    0.08 * solarScore;

  if (candidate.directionConfidence === "High") {
    score += 0.08;
  } else if (candidate.directionConfidence === "Medium") {
    score += 0.04;
  }

  if (candidate.offContinent && userProfile.operatingStyle === "dx") {
    score += 0.06;
  }

  return score;
}

function scoreDxEventStrength(candidate: CandidateEvidence): number {
  if (candidate.dxEventType === "Possible DXpedition") {
    return 1;
  }

  if (candidate.dxEventType === "Rare DX active") {
    return 0.85;
  }

  if (candidate.dxEventType === "Multi-band DX activity") {
    return 0.7;
  }

  if (candidate.dxEventType === "High spotter interest") {
    return 0.6;
  }

  return candidate.signals.includes("Rare DX active") ? 0.55 : 0.2;
}

function isDuplicateDxCandidate(
  candidate: CandidateEvidence,
  bestCandidate: CandidateEvidence | null,
): boolean {
  if (!bestCandidate) {
    return false;
  }

  const sameCallsign = candidate.callsign === bestCandidate.callsign;
  const sameBand = candidate.band === bestCandidate.band;
  const sameFrequency = Math.abs((candidate.frequency ?? 0) - (bestCandidate.frequency ?? 0)) <= 10;
  const strongDxEvidence = candidate.rarityScore >= 90 || scoreDxEventStrength(candidate) >= 0.85;

  if (sameCallsign && sameBand && sameFrequency && !strongDxEvidence) {
    return true;
  }

  return false;
}

function inferDirection(
  homeGrid: string,
  representative: StoredOpportunitySpot,
  context: BandContext,
): (typeof directionOrder)[number] {
  if (context.pathDensity?.dominantDirection && context.pathDensity.confidence === "High") {
    return context.pathDensity.dominantDirection;
  }

  const bestDirection = directionOrder.reduce<(typeof directionOrder)[number] | null>((best, direction) => {
    if (!best || context.pskDirectionCounts[direction] > context.pskDirectionCounts[best]) {
      return direction;
    }

    return best;
  }, null);

  if (bestDirection && context.pskDirectionCounts[bestDirection] > 0) {
    return bestDirection;
  }

  if (homeGrid && representative.dxLocator) {
    const path = estimatePathBetweenLocators(homeGrid, representative.dxLocator);
    if (path) {
      return path.direction;
    }
  }

  return "W";
}

function inferBeamHeading(
  homeGrid: string,
  representative: StoredOpportunitySpot,
  direction: (typeof directionOrder)[number],
  context?: BandContext,
): number {
  if (homeGrid && representative.dxLocator) {
    const path = estimatePathBetweenLocators(homeGrid, representative.dxLocator);
    if (path) {
      return Math.round(path.bearingDegrees);
    }
  }

  if (context?.pathDensity?.beamHeading) {
    return context.pathDensity.beamHeading;
  }

  return directionCenterDegrees[direction];
}

function inferMode(
  representative: StoredOpportunitySpot,
  context: BandContext,
  modePreference: readonly string[],
): string {
  const preferred = modePreference.find((mode) => (context.pskModeCounts[mode] ?? 0) > 0);

  if (preferred) {
    return preferred;
  }

  const fromSpot = normalizeSpotMode(representative.mode);

  if (fromSpot) {
    return fromSpot;
  }

  return Object.entries(context.pskModeCounts)
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "FT8";
}

function normalizeSpotMode(mode: StoredOpportunitySpot["mode"]): string | null {
  if (mode === "ft8") {
    return "FT8";
  }

  if (mode === "ft4") {
    return "FT4";
  }

  if (mode === "ssb") {
    return "SSB";
  }

  if (mode === "cw") {
    return "CW";
  }

  if (mode === "digital") {
    return "DIGITAL";
  }

  return null;
}

function selectRepresentativeSpot(spots: readonly StoredOpportunitySpot[]): StoredOpportunitySpot | null {
  if (spots.length === 0) {
    return null;
  }

  return spots.slice().sort((left, right) => getSpotTimestamp(right) - getSpotTimestamp(left))[0] ?? null;
}

function getEntityName(countryCode: string | undefined): string | undefined {
  if (!countryCode) {
    return undefined;
  }

  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    return displayNames.of(countryCode.toUpperCase()) ?? countryCode.toUpperCase();
  } catch {
    return countryCode.toUpperCase();
  }
}

function directionLabel(direction: (typeof directionOrder)[number]): string {
  const labels: Record<(typeof directionOrder)[number], string> = {
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

function shortDirectionLabel(direction: (typeof directionOrder)[number]): string {
  return direction;
}

function toBandState(
  prediction: BandPrediction | null,
): "Opening" | "Stable" | "Fading" {
  if (prediction?.state === "opening") {
    return "Opening";
  }

  if (prediction?.state === "fading") {
    return "Fading";
  }

  return "Stable";
}

function toTrendLabel(
  prediction: BandPrediction | null,
  context: BandContext,
): "Rising" | "Steady" | "Falling" {
  if (prediction?.state === "opening") {
    return "Rising";
  }

  if (prediction?.state === "fading") {
    return "Falling";
  }

  if (context.pskCurrent > context.pskPrevious * 1.2 && context.pskCurrent > 0) {
    return "Rising";
  }

  if (context.pskPrevious > 0 && context.pskCurrent < context.pskPrevious * 0.8) {
    return "Falling";
  }

  return "Steady";
}

function isOffContinent(spot: StoredOpportunitySpot, homeContinent: string): boolean {
  const dxContinent = spot.continentDx?.trim().toUpperCase()
    ?? (spot.dxLocator ? deriveContinentFromMaidenhead(spot.dxLocator) : undefined);

  return Boolean(dxContinent && homeContinent && dxContinent !== homeContinent);
}

function isPortable(tags: readonly SpotTag[]): boolean {
  return tags.some((tag) => isPortableTag(tag));
}

function isPortableTag(tag: SpotTag): boolean {
  return tag === "SOTA" || tag === "POTA" || tag === "WWFF" || tag === "/P";
}

function getDistanceKm(homeGrid: string, dxLocator: string | undefined): number | null {
  if (!homeGrid || !dxLocator) {
    return null;
  }

  return estimatePathBetweenLocators(homeGrid, dxLocator)?.distanceKm ?? null;
}

function getSpotTimestamp(spot: StoredOpportunitySpot): number {
  const observedAt = spot.observedAt ? Date.parse(spot.observedAt) : Number.NaN;
  return Number.isFinite(observedAt) ? observedAt : Date.parse(spot.receivedAt);
}

function normalizeSolarNumber(value: number | string | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function bandLooksSupportedByMuf(band: Band, muf: number): boolean {
  if (band === "10m") {
    return muf >= 28;
  }

  if (band === "12m") {
    return muf >= 24;
  }

  if (band === "15m") {
    return muf >= 21;
  }

  if (band === "17m") {
    return muf >= 18;
  }

  if (band === "20m") {
    return muf >= 14;
  }

  return true;
}

function emptyDirectionCounts(): Record<(typeof directionOrder)[number], number> {
  return {
    N: 0,
    NE: 0,
    E: 0,
    SE: 0,
    S: 0,
    SW: 0,
    W: 0,
    NW: 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
