import {
  getCombinedRarity,
  getSpotEntityKey,
  loadDxRarityContext,
  type DxBaselineRedisClient,
  type DxRarityContext,
} from "./dxRarity.js";
import type { ParsedSpot } from "./types.js";

const EVENT_WINDOW_MS = 20 * 60 * 1000;

export interface DxEventRedisClient extends DxBaselineRedisClient {}

export interface DxEventCandidate {
  readonly callsign: string;
  readonly entity?: string;
  readonly eventType: "Rare DX active" | "Possible DXpedition" | "High spotter interest" | "Multi-band DX activity";
  readonly activityScore: number;
  readonly rarityScore: number;
  readonly spotterDiversity: number;
  readonly signals: readonly string[];
}

interface DxEventGroup {
  readonly callsign: string;
  readonly entity?: string;
  readonly spots: readonly ParsedSpot[];
  readonly recentSpots: readonly ParsedSpot[];
  readonly spotterCount: number;
  readonly bandCount: number;
  readonly modeCount: number;
  readonly expeditionLike: boolean;
}

interface DxEventScoreContext {
  readonly rarity: DxRarityContext | null;
  readonly now: number;
}

interface DetectDxEventsOptions {
  readonly rarity?: DxRarityContext | null;
}

export async function detectDxEvents(
  spots: readonly ParsedSpot[],
  redisClient: DxEventRedisClient,
  now = Date.now(),
  options: DetectDxEventsOptions = {},
): Promise<readonly DxEventCandidate[]> {
  if (spots.length === 0) {
    return [];
  }

  const rarity = options.rarity ?? await loadDxRarityContext(redisClient, spots, now);
  const context: DxEventScoreContext = { rarity, now };

  return buildDxEventGroups(spots, now)
    .map((group) => scoreDxEvent(group, context))
    .filter((candidate) => candidate !== null)
    .sort((left, right) => {
      const leftScore = left.activityScore + left.rarityScore + left.spotterDiversity;
      const rightScore = right.activityScore + right.rarityScore + right.spotterDiversity;

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return left.callsign.localeCompare(right.callsign);
    });
}

export function scoreDxEvent(
  candidate: DxEventGroup,
  context: DxEventScoreContext,
): DxEventCandidate | null {
  const rarityScore = getCombinedRarity(
    candidate.callsign,
    normalizeEntityKey(candidate.entity),
    context.rarity,
  );
  const activityScore = scoreActivity(candidate);
  const spotterDiversity = scoreSpotterDiversity(candidate);
  const signals = buildSignals(candidate, activityScore, rarityScore, spotterDiversity);

  if (signals.length === 0) {
    return null;
  }

  return {
    callsign: candidate.callsign,
    entity: candidate.entity,
    eventType: classifyEventType(candidate, rarityScore, spotterDiversity),
    activityScore: round2(activityScore),
    rarityScore: round2(rarityScore),
    spotterDiversity: round2(spotterDiversity),
    signals,
  };
}

function buildDxEventGroups(
  spots: readonly ParsedSpot[],
  now: number,
): readonly DxEventGroup[] {
  const grouped = new Map<string, ParsedSpot[]>();

  for (const spot of spots) {
    const callsign = normalizeCallsign(spot.spottedCallsign);

    if (!callsign) {
      continue;
    }

    const existing = grouped.get(callsign);

    if (existing) {
      existing.push(spot);
    } else {
      grouped.set(callsign, [spot]);
    }
  }

  return [...grouped.entries()].map(([callsign, groupSpots]) => {
    const recentSpots = groupSpots.filter((spot) => getSpotTime(spot) >= now - EVENT_WINDOW_MS);
    const spotterCount = new Set(groupSpots.map((spot) => normalizeCallsign(spot.spotterCallsign)).filter(isNonEmpty)).size;
    const bandCount = new Set(groupSpots.map((spot) => spot.band).filter(isBandLike)).size;
    const modeCount = new Set(groupSpots.map((spot) => normalizeMode(spot.mode)).filter(isNonEmpty)).size;
    const entity = getEntityName(groupSpots[0]);

    return {
      callsign,
      entity,
      spots: groupSpots,
      recentSpots,
      spotterCount,
      bandCount,
      modeCount,
      expeditionLike: isExpeditionLikeCallsign(callsign),
    };
  });
}

function scoreActivity(group: DxEventGroup): number {
  const freshSpotScore = clamp01(group.recentSpots.length / 12);
  const spotterScore = clamp01(group.spotterCount / 10);
  const multiBandScore = group.bandCount >= 2 ? 1 : group.bandCount === 1 ? 0.4 : 0;
  const multiModeScore = group.modeCount >= 2 ? 0.8 : group.modeCount === 1 ? 0.4 : 0;

  return clamp01(
    0.45 * freshSpotScore +
    0.25 * spotterScore +
    0.2 * multiBandScore +
    0.1 * multiModeScore,
  );
}

function scoreSpotterDiversity(group: DxEventGroup): number {
  if (group.spots.length === 0) {
    return 0;
  }

  const ratio = group.spotterCount / group.spots.length;
  const breadth = clamp01(group.spotterCount / 12);
  return clamp01(0.6 * ratio + 0.4 * breadth);
}

function buildSignals(
  group: DxEventGroup,
  activityScore: number,
  rarityScore: number,
  spotterDiversity: number,
): readonly string[] {
  const signals: string[] = [];

  if (rarityScore >= 0.75) {
    signals.push("Rare DX active");
  }

  if (group.expeditionLike && (rarityScore >= 0.55 || activityScore >= 0.55)) {
    signals.push("Possible DXpedition");
  }

  if (spotterDiversity >= 0.65 || group.spotterCount >= 8) {
    signals.push("High spotter interest");
  }

  if (group.bandCount >= 2 || group.modeCount >= 2) {
    signals.push("Multi-band DX activity");
  }

  return signals;
}

function classifyEventType(
  group: DxEventGroup,
  rarityScore: number,
  spotterDiversity: number,
): DxEventCandidate["eventType"] {
  if (group.expeditionLike && (rarityScore >= 0.55 || group.recentSpots.length >= 5)) {
    return "Possible DXpedition";
  }

  if (rarityScore >= 0.75) {
    return "Rare DX active";
  }

  if (group.bandCount >= 2 || group.modeCount >= 2) {
    return "Multi-band DX activity";
  }

  return spotterDiversity >= 0.65 ? "High spotter interest" : "Rare DX active";
}

function getEntityName(spot: ParsedSpot | undefined): string | undefined {
  if (!spot) {
    return undefined;
  }

  const countryCode = normalizeEntityKey(spot.countryCode);

  if (countryCode) {
    try {
      return new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) ?? countryCode;
    } catch {
      return countryCode;
    }
  }

  return normalizeEntityKey(getSpotEntityKey(spot));
}

function getSpotTime(spot: ParsedSpot): number {
  const observedAt = typeof spot.observedAt === "string" ? Date.parse(spot.observedAt) : Number.NaN;
  return Number.isFinite(observedAt) ? observedAt : 0;
}

function isExpeditionLikeCallsign(callsign: string): boolean {
  return (
    callsign.includes("/") ||
    /^[A-Z]{1,3}\d[A-Z]{2,4}$/.test(callsign) ||
    /^[A-Z0-9]{5,8}$/.test(callsign)
  );
}

function normalizeCallsign(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeEntityKey(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMode(value: ParsedSpot["mode"]): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBandLike(value: ParsedSpot["band"]): value is NonNullable<ParsedSpot["band"]> {
  return typeof value === "string" && value.length > 0;
}
