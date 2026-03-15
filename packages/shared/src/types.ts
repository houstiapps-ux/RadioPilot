import type { Band } from "./bands.js";

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

export interface OpportunitySnapshot {
  readonly generatedAt: string;
  readonly cards: readonly OpportunityCard[];
  readonly bestOpportunity: OpportunityCard | null;
  readonly watchNext: readonly OpportunityCard[];
  readonly dxOpportunity: OpportunityCard | null;
  readonly nearbyActivity: readonly OpportunityCard[];
}
