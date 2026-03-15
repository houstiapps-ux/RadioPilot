import type { OpportunitySnapshot, PskBandTrendMap } from "../types.js";
import { buildOpportunitySnapshotWithDebug } from "../opportunities.js";
import type { OpportunityEngineInputs, OpportunityEngineQuery, OpportunityInputStorage } from "../shared-storage/types.js";

export const OPPORTUNITY_RECENT_WINDOW_MS = 15 * 60 * 1000;

export async function loadOpportunityEngineInputs(
  storage: OpportunityInputStorage,
  options: {
    readonly now?: number;
    readonly homeGrid?: string;
  } = {},
): Promise<OpportunityEngineInputs> {
  const now = options.now ?? Date.now();
  const [{ raw, parsed }, solar, pskSummary, pskTrends, bandPredictions, propagationDensity] = await Promise.all([
    storage.getRecentSpots({
      now,
      windowMs: OPPORTUNITY_RECENT_WINDOW_MS * 2,
    }),
    storage.getSolar(),
    storage.getPskSummaries(),
    storage.getPskTrends(),
    storage.getBandPredictions({ homeGrid: options.homeGrid }),
    storage.getDirectionalSummaries({ homeGrid: options.homeGrid }),
  ]);
  const dxRarity = await storage.getDxRarity(parsed, now);
  const dxEvents = await storage.getDxEvents(parsed, now, { rarity: dxRarity });

  return {
    now,
    rawSpots: raw,
    spots: parsed,
    solar,
    pskSummary,
    pskTrends,
    bandPredictions,
    propagationDensity,
    dxRarity,
    dxEvents,
    bandResolution: storage.summarizeBandResolution(raw),
  };
}

export function buildOpportunitySnapshotFromInputs(
  inputs: OpportunityEngineInputs,
  query: OpportunityEngineQuery,
): ReturnType<typeof buildOpportunitySnapshotWithDebug> {
  if (inputs.spots.length === 0) {
    return {
      snapshot: {
        generatedAt: new Date(0).toISOString(),
        cards: [],
        bestOpportunity: null,
        watchNext: [],
        dxOpportunity: null,
        nearbyActivity: [],
        solar: null,
      },
      bands: [],
      candidates: [],
      dxCandidates: [],
      nearbyCandidates: [],
      bandResolution: inputs.bandResolution,
    };
  }

  const built = buildOpportunitySnapshotWithDebug(inputs.spots, {
    now: inputs.now,
    homeGrid: query.homeGrid,
    operatingStyle: query.operatingStyle,
    chasing: query.chasing,
    modeFilter: query.modeFilter,
    bandScope: query.bandScope,
    pskSummary: isFreshPskSummary(inputs.pskSummary, inputs.now) ? inputs.pskSummary : null,
    pskTrends: filterFreshPskTrends(inputs.pskTrends),
    dxRarity: inputs.dxRarity,
    dxEvents: inputs.dxEvents,
    solar: inputs.solar,
    bandPredictions: inputs.bandPredictions,
    propagationDensity: inputs.propagationDensity,
  });

  return {
    ...built,
    snapshot: {
      ...built.snapshot,
      solar: inputs.solar,
    },
  };
}

export function buildOpportunitySnapshotOnlyFromInputs(
  inputs: OpportunityEngineInputs,
  query: OpportunityEngineQuery,
): OpportunitySnapshot {
  return buildOpportunitySnapshotFromInputs(inputs, query).snapshot;
}

function isFreshPskSummary(summary: OpportunityEngineInputs["pskSummary"], now: number): boolean {
  if (!summary) {
    return false;
  }

  const freshness = Date.parse(summary.freshnessTimestamp);
  return Number.isFinite(freshness) && freshness >= now - OPPORTUNITY_RECENT_WINDOW_MS * 2;
}

function filterFreshPskTrends(trends: PskBandTrendMap): PskBandTrendMap {
  return trends;
}
