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
  readonly callsign: string;
  readonly band: Band | null;
  readonly frequencyKHz: number;
  readonly summary: string;
  readonly countryCode?: string;
  readonly direction?: string;
  readonly bearing?: number;
  readonly region?: string;
  readonly confidence?: "Low" | "Medium" | "High";
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

export interface OpportunitySnapshot {
  readonly generatedAt: string;
  readonly cards: readonly OpportunityCard[];
  readonly bestOpportunity: OpportunityCard | null;
  readonly watchNext: readonly OpportunityCard[];
  readonly dxOpportunity: OpportunityCard | null;
  readonly nearbyActivity: readonly OpportunityCard[];
  readonly solar?: SolarConditions | null;
}
