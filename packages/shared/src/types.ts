import type { Band } from "./bands.js";

export type SpotMode = "CW" | "SSB" | "FT8" | "FT4";
export type SpotTag = "SOTA" | "POTA" | SpotMode;

export interface ParsedSpot {
  readonly spotterCallsign: string;
  readonly spottedCallsign: string;
  readonly frequencyKHz: number;
  readonly band: Band | null;
  readonly comment: string;
  readonly tags: readonly SpotTag[];
}

export interface OpportunityCard {
  readonly id: string;
  readonly callsign: string;
  readonly band: Band | null;
  readonly frequencyKHz: number;
  readonly summary: string;
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
