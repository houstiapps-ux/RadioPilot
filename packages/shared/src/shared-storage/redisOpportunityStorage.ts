import { predictBandOpenings } from "../bandPredictor.js";
import { detectDxEvents } from "../dxEvents.js";
import { loadDxRarityContext } from "../dxRarity.js";
import { parseStoredOpportunitySpot, summarizeStoredSpotBandResolution } from "../opportunities.js";
import { getDirectionalPropagation } from "../pathDensity.js";
import { getAllBandTrends } from "../pskTrends.js";
import type { BandPredictionMap, PropagationDensityMap, PskBandTrendMap, PskReporterSummary, SolarConditions } from "../types.js";
import type { DxEventCandidate } from "../dxEvents.js";
import type { DxRarityContext } from "../dxRarity.js";
import type { StoredOpportunitySpot } from "../opportunities.js";
import type { OpportunityInputStorage, OpportunityStorageUserProfile } from "./types.js";

export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  zRangeByScore(key: string, min: number, max: number): Promise<string[]>;
  hGet(key: string, field: string): Promise<string | null>;
  hmGet(key: string, fields: string[]): Promise<Array<string | null>>;
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export class RedisOpportunityStorage implements OpportunityInputStorage {
  constructor(private readonly redis: RedisLikeClient) {}

  async getSolar(): Promise<SolarConditions | null> {
    const rawSolar = await this.redis.get("solar:latest");
    return parseSolar(rawSolar);
  }

  async getRecentSpots(range: {
    readonly now: number;
    readonly windowMs: number;
  }): Promise<{
    readonly raw: readonly string[];
    readonly parsed: readonly StoredOpportunitySpot[];
  }> {
    const raw = await this.redis.zRangeByScore("spots:recent", range.now - range.windowMs, range.now);
    return {
      raw,
      parsed: raw.flatMap(parseStoredOpportunitySpot),
    };
  }

  async getPskSummaries(): Promise<PskReporterSummary | null> {
    return parsePskSummary(await this.redis.get("psk:summary"));
  }

  async getPskTrends(): Promise<PskBandTrendMap> {
    return getAllBandTrends(this.redis);
  }

  async getBandPredictions(userProfile?: OpportunityStorageUserProfile): Promise<BandPredictionMap> {
    return predictBandOpenings(this.redis, userProfile ?? {});
  }

  async getDirectionalSummaries(userProfile?: OpportunityStorageUserProfile): Promise<PropagationDensityMap> {
    return getDirectionalPropagation(this.redis, userProfile ?? {});
  }

  async getDxRarity(
    spots: readonly StoredOpportunitySpot[],
    now: number,
  ): Promise<DxRarityContext | null> {
    return loadDxRarityContext(this.redis, spots, now);
  }

  async getDxEvents(
    spots: readonly StoredOpportunitySpot[],
    now: number,
    context: { readonly rarity: DxRarityContext | null },
  ): Promise<readonly DxEventCandidate[]> {
    return detectDxEvents(spots, this.redis, now, { rarity: context.rarity });
  }

  summarizeBandResolution(rawSpots: readonly string[]): {
    sourceBandMissing: number;
    frequencyDerivedBandUsed: number;
    unresolvedBand: number;
  } {
    return summarizeStoredSpotBandResolution(rawSpots);
  }
}

function parseSolar(value: string | null): SolarConditions | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SolarConditions>;

    if (typeof parsed.updatedAt !== "string") {
      return null;
    }

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
      favouredBands: Array.isArray(parsed.favouredBands) ? parsed.favouredBands : undefined,
      solarSummary: Array.isArray(parsed.solarSummary) ? parsed.solarSummary : undefined,
    };
  } catch {
    return null;
  }
}

function parsePskSummary(value: string | null): PskReporterSummary | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as PskReporterSummary;
    return Array.isArray(parsed.bands) ? parsed : null;
  } catch {
    return null;
  }
}
