import type { Band } from "./bands.js";
import {
  deriveContinentFromMaidenhead,
  estimatePathBetweenLocators,
  parseMaidenheadLocator,
} from "./maidenhead.js";
import {
  parseStoredOpportunitySpot,
  type StoredOpportunitySpot,
} from "./opportunities.js";
import type { PskReporterSummary, SolarConditions, SpotTag } from "./types.js";

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
}

interface LoadedRedisState {
  readonly spots: readonly StoredOpportunitySpot[];
  readonly pskSummary: PskReporterSummary | null;
  readonly pskDirectionalCounts: ReadonlyMap<Band, Readonly<Record<(typeof directionOrder)[number], number>>>;
  readonly solar: SolarConditions | null;
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
  const candidates = supportedBands
    .map((band) => buildBandCandidate(
      band,
      currentSpots,
      previousSpots,
      state,
      normalizedProfile,
    ))
    .flatMap((candidate) => candidate ? [candidate] : [])
    .sort((left, right) => right.totalScore - left.totalScore);

  const bestCandidate = candidates[0] ?? null;

  return {
    bestOpportunity: toCard(bestCandidate),
    watchNext: toCard(selectWatchNext(candidates, bestCandidate)),
    dxOpportunity: toCard(selectDxOpportunity(candidates, bestCandidate)),
    nearbyActivity: toCard(selectNearbyActivity(currentSpots, normalizedProfile, state.solar)),
  };
}

async function loadRedisState(redisClient: OpportunityRedisClient): Promise<LoadedRedisState> {
  const now = Date.now();
  const [rawSpots, rawPskSummary, rawPskFreshness, rawSolarCurrent, rawSolarLatest] = await Promise.all([
    redisClient.zRangeByScore("spots:recent", now - RECENT_WINDOW_MS * 2, now),
    redisClient.get("psk:summary"),
    redisClient.get("psk:freshness"),
    redisClient.get("solar:current"),
    redisClient.get("solar:latest"),
  ]);

  return {
    spots: rawSpots.flatMap(parseStoredOpportunitySpot),
    pskSummary: parseFreshPskSummary(rawPskSummary, rawPskFreshness),
    pskDirectionalCounts: await loadDirectionalCounts(redisClient),
    solar: parseSolar(rawSolarCurrent) ?? parseSolar(rawSolarLatest),
  };
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
  };
  const direction = inferDirection(userProfile.homeGrid, representative, context);
  const beamHeading = inferBeamHeading(userProfile.homeGrid, representative, direction);
  const mode = inferMode(representative, context, userProfile.modePreference);
  const offContinent = isOffContinent(representative, userProfile.homeContinent);
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
      if (right.trendScore !== left.trendScore) {
        return right.trendScore - left.trendScore;
      }

      return right.totalScore - left.totalScore;
    })[0] ?? null;
}

function selectDxOpportunity(
  candidates: readonly CandidateEvidence[],
  bestCandidate: CandidateEvidence | null,
): CandidateEvidence | null {
  const dxCandidate = candidates
    .filter((candidate) => candidate.offContinent || candidate.rarityScore >= 45)
    .sort((left, right) => {
      const leftDxScore = left.pathScore + left.rarityScore + left.userPreferenceScore;
      const rightDxScore = right.pathScore + right.rarityScore + right.userPreferenceScore;

      if (rightDxScore !== leftDxScore) {
        return rightDxScore - leftDxScore;
      }

      return right.totalScore - left.totalScore;
    })[0];

  return dxCandidate ?? candidates.find((candidate) => candidate.band !== bestCandidate?.band) ?? null;
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
      };
      const direction = inferDirection(userProfile.homeGrid, spot, context);
      const beamHeading = inferBeamHeading(userProfile.homeGrid, spot, direction);
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
  return clamp(40 + pskTrend * 0.5 + spotTrend * 6, 0, 100);
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

function inferDirection(
  homeGrid: string,
  representative: StoredOpportunitySpot,
  context: BandContext,
): (typeof directionOrder)[number] {
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
): number {
  if (homeGrid && representative.dxLocator) {
    const path = estimatePathBetweenLocators(homeGrid, representative.dxLocator);
    if (path) {
      return Math.round(path.bearingDegrees);
    }
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
