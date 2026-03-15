import type { Band } from "./bands.js";
import type { MaidenheadPathEstimate } from "./maidenhead.js";

export type SpotMode = "CW" | "SSB" | "FT8" | "FT4";
export type ParsedSpotMode = "cw" | "ssb" | "ft8" | "ft4" | "digital" | "unknown";
export type ParsedSpotModeFamily = "cw" | "phone" | "digital" | "unknown";
export type SpotTag = "SOTA" | "POTA" | "WWFF" | "/P" | SpotMode;

export interface ParsedSpot {
  readonly id: string;
  readonly source: string;
  readonly spotterCallsign: string;
  readonly spottedCallsign: string;
  readonly continentDx?: string;
  readonly countryCode?: string;
  readonly dxLocator?: string;
  readonly frequencyKHz: number;
  readonly frequencyHz?: number;
  readonly band: Band | null;
  readonly observedAt?: string;
  readonly mode?: ParsedSpotMode;
  readonly modeFamily?: ParsedSpotModeFamily;
  readonly comment: string;
  readonly tags: readonly SpotTag[];
}

export interface OpportunityCard {
  readonly id: string;
  readonly cardType?: "best" | "watch" | "dx" | "nearby";
  readonly callsign: string;
  readonly entity?: string;
  readonly dxEventType?: string;
  readonly band: Band | null;
  readonly frequencyKHz: number;
  readonly frequencyMhz?: string;
  readonly summary: string;
  readonly countryCode?: string;
  readonly direction?: string;
  readonly bearing?: number;
  readonly beamHeading?: number;
  readonly directionConfidence?: "High" | "Medium" | "Low";
  readonly strongestPropagationSignal?: string;
  readonly region?: string;
  readonly confidence?: "Low" | "Medium" | "High";
  readonly confidenceReason?: string;
  readonly activityLevel?: "High" | "Moderate" | "Low";
  readonly bandState?: "Opening" | "Stable" | "Fading";
  readonly freshnessSeconds?: number;
  readonly actionLine?: string;
  readonly signals?: readonly string[];
  readonly why?: readonly string[];
  readonly modeSummary?: string;
  readonly distanceKm?: number;
  readonly trendLabel?: "Rising" | "Steady" | "Falling";
  readonly portable?: boolean;
  readonly portableType?: "SOTA" | "POTA" | "Portable";
  readonly regional?: boolean;
  readonly tags: readonly SpotTag[];
  readonly score: number;
}

export interface SolarConditions {
  readonly sfi?: number;
  readonly kp?: number;
  readonly aIndex?: number;
  readonly muf?: number | string;
  readonly sunspots?: number;
  readonly updatedAt: string;
  readonly favouredBands?: readonly string[];
  readonly solarSummary?: readonly string[];
}

export interface ActivationRecord {
  readonly id: string;
  readonly programme: "SOTA" | "POTA";
  readonly reference: string;
  readonly callsign: string;
  readonly band: Band | null;
  readonly mode?: string;
  readonly locator?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly observedAt: string;
}

export interface PskReporterReport {
  readonly observedAt: string;
  readonly frequencyHz: number;
  readonly band: Band | null;
  readonly mode: string;
  readonly senderCallsign: string;
  readonly senderLocator: string;
  readonly receiverCallsign: string;
  readonly receiverLocator: string;
}

export interface PskReporterBandSummary {
  readonly band: Band | null;
  readonly currentWindowCount: number;
  readonly previousWindowCount: number;
  readonly trend: number;
  readonly modeCounts: Readonly<Record<string, number>>;
  readonly directionCounts: Readonly<Partial<Record<MaidenheadPathEstimate["direction"], number>>>;
  readonly pathCounts: Readonly<Record<string, number>>;
  readonly uniqueSenderLocatorCount: number;
  readonly uniqueReceiverLocatorCount: number;
}

export interface PskReporterSummary {
  readonly generatedAt: string;
  readonly freshnessTimestamp: string;
  readonly currentWindowStart: string;
  readonly previousWindowStart: string;
  readonly windowMinutes: number;
  readonly bands: readonly PskReporterBandSummary[];
}

export interface PskBandWindowSummary {
  readonly count: number;
  readonly uniqueCalls: number;
  readonly uniqueGrids: number;
  readonly modes: Readonly<Record<"FT8" | "FT4", number>>;
  readonly updatedAt: number;
}

export interface PskBandTrend {
  readonly trend: "rising" | "steady" | "falling";
  readonly volumeDelta: number;
  readonly uniqueCallDelta: number;
  readonly gridDelta: number;
  readonly confidence: "High" | "Medium" | "Low";
}

export type PskBandTrendMap = Readonly<Partial<Record<Band, PskBandTrend>>>;

export interface BandPrediction {
  readonly state: "opening" | "stable" | "fading";
  readonly score: number;
  readonly volumeDelta: number;
  readonly uniqueCallDelta: number;
  readonly gridDelta: number;
  readonly directionStrength: number;
  readonly solarSupport: number;
  readonly signals: readonly string[];
}

export type BandPredictionMap = Readonly<Partial<Record<Band, BandPrediction>>>;

export interface PropagationBandDensity {
  readonly direction?: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  readonly dominantDirection?: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  readonly heading?: number;
  readonly sector?: string | null;
  readonly beamHeading?: number;
  readonly confidence: "High" | "Medium" | "Low";
  readonly densities: Readonly<Partial<Record<MaidenheadPathEstimate["direction"], number>>>;
}

export type PropagationDensityMap = Readonly<Partial<Record<Band, PropagationBandDensity>>>;

export interface OpportunitySnapshot {
  readonly generatedAt: string;
  readonly cards: readonly OpportunityCard[];
  readonly bestOpportunity: OpportunityCard | null;
  readonly watchNext: readonly OpportunityCard[];
  readonly dxOpportunity: OpportunityCard | null;
  readonly nearbyActivity: readonly OpportunityCard[];
  readonly solar?: SolarConditions | null;
}
