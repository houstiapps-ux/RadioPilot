import { distanceKm as gridDistanceKm } from "./geo.js";
import { estimatePathBetweenLocators, parseMaidenheadLocator } from "./maidenhead.js";
import { NEARBY_SCORING } from "./scoringConfig.js";
import type { OpportunityCard, OpportunityScoreBreakdown, ParsedSpot } from "./types.js";

const MAX_NEARBY_DISTANCE_KM = 2_500;
const LOCAL_DISTANCE_KM = 300;
const REGIONAL_DISTANCE_KM = 1_200;

export interface NearbyUserProfile {
  readonly homeGrid?: string;
}

export interface NearbySpot extends ParsedSpot {
  readonly receivedAt: string;
}

export interface NearbyCandidateDebug {
  readonly callsign: string;
  readonly distanceKm: number;
  readonly portable: boolean;
  readonly portableType: "SOTA" | "POTA" | "Portable" | null;
  readonly band: string;
  readonly score: number;
  readonly scoreBreakdown: OpportunityScoreBreakdown;
}

export interface NearbyResult {
  readonly cards: readonly OpportunityCard[];
  readonly candidates: readonly NearbyCandidateDebug[];
}

export function findNearbyOpportunities(
  userProfile: NearbyUserProfile,
  spots: readonly NearbySpot[],
  _redis?: unknown,
  now = Date.now(),
): NearbyResult {
  const homeGrid = normalizeGrid(userProfile.homeGrid);

  if (!homeGrid) {
    return { cards: [], candidates: [] };
  }

  const callCounts = buildCallCounts(spots);
  const nearbyCandidates = spots
    .flatMap((spot) => {
      if (!spot.band) {
        return [];
      }

      const dxGrid = normalizeGrid(spot.dxLocator);

      if (!dxGrid) {
        return [];
      }

      const distance = gridDistanceKm(homeGrid, dxGrid);

      if (distance === null || distance > MAX_NEARBY_DISTANCE_KM) {
        return [];
      }

      const portableType = detectPortableType(spot);
      const path = estimatePathBetweenLocators(homeGrid, dxGrid);
      const freshnessSeconds = getFreshnessSeconds(spot, now);
      const distanceScore = scoreDistance(distance);
      const activityScore = scoreActivity(callCounts.get(spot.spottedCallsign) ?? 1);
      const portableBoost = scorePortable(portableType);
      const bandSuitability = scoreBandSuitability(spot.band);
      const freshness = scoreFreshness(freshnessSeconds);
      const totalScore =
        NEARBY_SCORING.weights.distance * distanceScore +
        NEARBY_SCORING.weights.activity * activityScore +
        NEARBY_SCORING.weights.portable * portableBoost +
        NEARBY_SCORING.weights.bandSuitability * bandSuitability +
        NEARBY_SCORING.weights.freshness * freshness;
      const distanceRounded = Math.round(distance);
      const activityLevel = totalScore >= NEARBY_SCORING.thresholds.highActivity
        ? "High"
        : totalScore >= NEARBY_SCORING.thresholds.moderateActivity
          ? "Moderate"
          : "Low";
      const confidence = portableType || distance <= REGIONAL_DISTANCE_KM
        ? totalScore >= NEARBY_SCORING.thresholds.localHighConfidence ? "High" : "Medium"
        : totalScore >= NEARBY_SCORING.thresholds.extendedHighConfidence ? "Medium" : "Low";
      const modeSummary = getModeSummary(spot);
      const why = buildWhy(spot, distanceRounded, portableType, activityScore, freshnessSeconds);
      const card: OpportunityCard = {
        id: `nearby:${spot.id}`,
        cardType: "nearby",
        callsign: spot.spottedCallsign,
        entity: getEntityName(spot.countryCode),
        countryCode: spot.countryCode,
        band: spot.band,
        frequencyKHz: spot.frequencyKHz,
        frequencyMhz: formatFrequencyMhz(spot.frequencyKHz),
        summary: why.join(", "),
        direction: path ? directionLabel(path.direction) : undefined,
        bearing: path ? path.bearingDegrees : undefined,
        beamHeading: path ? path.bearingDegrees : undefined,
        confidence,
        confidenceReason: portableType
          ? "Portable station with fresh regional activity"
          : distance <= REGIONAL_DISTANCE_KM
            ? "Regional path looks immediately workable"
            : "Extended regional path, less certain",
        activityLevel,
        bandState: freshnessSeconds <= 120 ? "Opening" : freshnessSeconds <= 420 ? "Stable" : "Fading",
        freshnessSeconds,
        actionLine: buildActionLine(spot.band, portableType, distanceRounded),
        signals: buildSignals(spot, portableType, distanceRounded),
        why,
        modeSummary,
        distanceKm: distanceRounded,
        trendLabel: "Steady",
        portable: portableType !== null,
        portableType: portableType ?? undefined,
        regional: distanceRounded <= REGIONAL_DISTANCE_KM,
        tags: spot.tags,
        score: Math.round(totalScore * 100),
      };

      return [{
        card,
        debug: {
          callsign: spot.spottedCallsign,
          distanceKm: distanceRounded,
          portable: portableType !== null,
          portableType,
          band: spot.band,
          score: Math.round(totalScore * 100) / 100,
          scoreBreakdown: {
            activityScore: roundScore(activityScore),
            pathScore: roundScore(distanceScore),
            trendScore: roundScore(freshness),
            modeFitScore: roundScore(bandSuitability),
            solarScore: 0,
            rarityScore: 0,
            userPreferenceScore: 0,
            nearbyScore: roundScore(portableBoost),
            totalScore: roundScore(totalScore),
          },
        },
      }];
    })
    .sort((left, right) => right.card.score - left.card.score);

  const dedupedCards = dedupeNearbyCards(nearbyCandidates.map((candidate) => candidate.card)).slice(0, 3);

  return {
    cards: dedupedCards,
    candidates: nearbyCandidates.slice(0, 10).map((candidate) => candidate.debug),
  };
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildCallCounts(spots: readonly NearbySpot[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const spot of spots) {
    counts.set(spot.spottedCallsign, (counts.get(spot.spottedCallsign) ?? 0) + 1);
  }

  return counts;
}

function detectPortableType(spot: NearbySpot): "SOTA" | "POTA" | "Portable" | null {
  const callsign = spot.spottedCallsign.toUpperCase();
  const comment = spot.comment.toUpperCase();

  if (spot.tags.includes("SOTA") || comment.includes("SOTA") || callsign.includes("/SOTA")) {
    return "SOTA";
  }

  if (spot.tags.includes("POTA") || comment.includes("POTA") || callsign.includes("/POTA")) {
    return "POTA";
  }

  if (
    spot.tags.includes("WWFF") ||
    spot.tags.includes("/P") ||
    comment.includes("/P") ||
    comment.includes("/M") ||
    comment.includes("/QRP") ||
    callsign.endsWith("/P") ||
    callsign.endsWith("/M") ||
    callsign.endsWith("/QRP")
  ) {
    return "Portable";
  }

  return null;
}

function scoreDistance(distance: number): number {
  if (distance <= LOCAL_DISTANCE_KM) {
    return 1;
  }

  if (distance <= REGIONAL_DISTANCE_KM) {
    return 0.8;
  }

  if (distance <= MAX_NEARBY_DISTANCE_KM) {
    return 0.45;
  }

  return 0;
}

function scoreActivity(callCount: number): number {
  if (callCount >= 3) {
    return 1;
  }

  if (callCount === 2) {
    return 0.7;
  }

  return 0.45;
}

function scorePortable(portableType: "SOTA" | "POTA" | "Portable" | null): number {
  if (portableType === "SOTA" || portableType === "POTA") {
    return 1;
  }

  if (portableType === "Portable") {
    return 0.75;
  }

  return 0;
}

function scoreBandSuitability(band: string): number {
  if (band === "80m" || band === "40m") {
    return 1;
  }

  if (band === "60m") {
    return 0.75;
  }

  if (band === "20m") {
    return 0.5;
  }

  return 0.25;
}

function scoreFreshness(freshnessSeconds: number): number {
  if (freshnessSeconds <= 60) {
    return 1;
  }

  if (freshnessSeconds <= 180) {
    return 0.8;
  }

  if (freshnessSeconds <= 600) {
    return 0.45;
  }

  return 0.2;
}

function getFreshnessSeconds(spot: NearbySpot, now: number): number {
  const observedAtMs = typeof spot.observedAt === "string" ? Date.parse(spot.observedAt) : Number.NaN;
  const receivedAtMs = Date.parse(spot.receivedAt);
  const timestamp = Number.isFinite(observedAtMs) ? observedAtMs : receivedAtMs;

  return Math.max(0, Math.round((now - timestamp) / 1000));
}

function buildSignals(
  spot: NearbySpot,
  portableType: "SOTA" | "POTA" | "Portable" | null,
  distanceKm: number,
): readonly string[] {
  const signals: string[] = [];

  if (portableType) {
    signals.push(portableType === "Portable" ? "Portable nearby" : `${portableType} active`);
  }

  if (distanceKm <= LOCAL_DISTANCE_KM) {
    signals.push("Local path");
  } else if (distanceKm <= REGIONAL_DISTANCE_KM) {
    signals.push("Regional path");
  } else {
    signals.push("Extended regional");
  }

  signals.push(`${spot.band} suited`);
  signals.push(getModeSummary(spot));

  return signals;
}

function buildWhy(
  spot: NearbySpot,
  distanceKm: number,
  portableType: "SOTA" | "POTA" | "Portable" | null,
  activityScore: number,
  freshnessSeconds: number,
): readonly string[] {
  const why: string[] = [];

  if (portableType) {
    why.push(
      portableType === "Portable"
        ? "Portable station"
        : `${portableType} station`,
    );
  }

  why.push(`${distanceKm} km away`);
  why.push(distanceKm <= REGIONAL_DISTANCE_KM ? "Fresh regional spots" : "Extended regional path");
  why.push(isRegionalBand(spot.band ?? "") ? "Good band for regional propagation" : "Higher band, shorter opening");

  if (activityScore >= 0.7) {
    why.push("Repeated fresh spotting");
  }

  if (freshnessSeconds <= 120) {
    why.push("Spotted moments ago");
  }

  return why.slice(0, 5);
}

function buildActionLine(
  band: string,
  portableType: "SOTA" | "POTA" | "Portable" | null,
  distanceKm: number,
): string {
  if (portableType === "SOTA") {
    return `SOTA station ~${distanceKm} km away`;
  }

  if (portableType === "POTA") {
    return `Call nearby POTA on ${band}`;
  }

  if (portableType === "Portable") {
    return `Call nearby portable on ${band}`;
  }

  return distanceKm <= REGIONAL_DISTANCE_KM
    ? `Regional activity on ${band}`
    : `Check extended regional activity on ${band}`;
}

function getModeSummary(spot: NearbySpot): string {
  if (spot.tags.includes("FT8") || spot.mode === "ft8") {
    return "FT8 active";
  }

  if (spot.tags.includes("FT4") || spot.mode === "ft4") {
    return "FT4 active";
  }

  if (spot.modeFamily === "phone" || spot.mode === "ssb") {
    return "SSB likely good";
  }

  if (spot.modeFamily === "cw" || spot.mode === "cw") {
    return "CW possible";
  }

  return "Mixed local activity";
}

function dedupeNearbyCards(cards: readonly OpportunityCard[]): OpportunityCard[] {
  const seen = new Set<string>();
  const result: OpportunityCard[] = [];

  for (const card of cards) {
    const key = `${card.callsign}|${card.band ?? "unknown"}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(card);
  }

  return result;
}

function formatFrequencyMhz(frequencyKHz: number): string {
  return `${(frequencyKHz / 1000).toFixed(3)} MHz`;
}

function directionLabel(direction: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW"): string {
  const labels = {
    N: "North",
    NE: "North-East",
    E: "East",
    SE: "South-East",
    S: "South",
    SW: "South-West",
    W: "West",
    NW: "North-West",
  } as const;

  return labels[direction];
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

function isRegionalBand(band: string): boolean {
  return band === "80m" || band === "60m" || band === "40m" || band === "20m";
}

function normalizeGrid(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return parseMaidenheadLocator(normalized) ? normalized : undefined;
}
