import type { BandPredictionMap, OpportunitySnapshot, PropagationDensityMap, PskBandTrendMap, PskReporterSummary, SolarConditions } from "../types.js";
import type { DxEventCandidate } from "../dxEvents.js";
import type { DxRarityContext } from "../dxRarity.js";
import type { StoredOpportunitySpot } from "../opportunities.js";

export interface OpportunityStorageUserProfile {
  readonly homeGrid?: string;
}

export interface OpportunityEngineInputs {
  readonly now: number;
  readonly rawSpots: readonly string[];
  readonly spots: readonly StoredOpportunitySpot[];
  readonly solar: SolarConditions | null;
  readonly pskSummary: PskReporterSummary | null;
  readonly pskTrends: PskBandTrendMap;
  readonly bandPredictions: BandPredictionMap;
  readonly propagationDensity: PropagationDensityMap;
  readonly dxRarity: DxRarityContext | null;
  readonly dxEvents: readonly DxEventCandidate[];
  readonly bandResolution: {
    sourceBandMissing: number;
    frequencyDerivedBandUsed: number;
    unresolvedBand: number;
  };
}

export interface OpportunityInputStorage {
  getSolar(): Promise<SolarConditions | null>;
  getRecentSpots(range: {
    readonly now: number;
    readonly windowMs: number;
  }): Promise<{
    readonly raw: readonly string[];
    readonly parsed: readonly StoredOpportunitySpot[];
  }>;
  getPskSummaries(): Promise<PskReporterSummary | null>;
  getPskTrends(): Promise<PskBandTrendMap>;
  getBandPredictions(userProfile?: OpportunityStorageUserProfile): Promise<BandPredictionMap>;
  getDirectionalSummaries(userProfile?: OpportunityStorageUserProfile): Promise<PropagationDensityMap>;
  getDxRarity(spots: readonly StoredOpportunitySpot[], now: number): Promise<DxRarityContext | null>;
  getDxEvents(
    spots: readonly StoredOpportunitySpot[],
    now: number,
    context: { readonly rarity: DxRarityContext | null },
  ): Promise<readonly DxEventCandidate[]>;
  summarizeBandResolution(rawSpots: readonly string[]): {
    sourceBandMissing: number;
    frequencyDerivedBandUsed: number;
    unresolvedBand: number;
  };
}

export interface OpportunityEngineQuery {
  readonly homeGrid?: string;
  readonly operatingStyle?: string;
  readonly chasing?: "dx" | "pota" | "sota" | "portable" | "digital";
  readonly modeFilter?: "ssb" | "cw" | "digital";
  readonly bandScope?: "hf" | "vhf-uhf";
}

export interface OpportunityEngineResultWithInputs {
  readonly inputs: OpportunityEngineInputs;
  readonly snapshot: OpportunitySnapshot;
}
