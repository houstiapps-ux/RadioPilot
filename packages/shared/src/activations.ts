import { parseMaidenheadLocator } from "./maidenhead.js";
import type { ActivationRecord } from "./types.js";

export interface StoredActivationRecord extends ActivationRecord {
  readonly receivedAt: string;
}

export function parseStoredActivation(rawValue: string): StoredActivationRecord[] {
  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredActivationRecord>;

    if (
      typeof parsed.id === "string" &&
      (parsed.programme === "SOTA" || parsed.programme === "POTA") &&
      typeof parsed.reference === "string" &&
      typeof parsed.callsign === "string" &&
      typeof parsed.observedAt === "string" &&
      typeof parsed.receivedAt === "string"
    ) {
      return [{
        id: parsed.id,
        programme: parsed.programme,
        reference: parsed.reference,
        callsign: parsed.callsign,
        band: typeof parsed.band === "string" ? parsed.band : null,
        mode: typeof parsed.mode === "string" ? parsed.mode : undefined,
        locator: normalizeLocator(parsed.locator),
        latitude: typeof parsed.latitude === "number" ? parsed.latitude : undefined,
        longitude: typeof parsed.longitude === "number" ? parsed.longitude : undefined,
        observedAt: parsed.observedAt,
        receivedAt: parsed.receivedAt,
      }];
    }
  } catch {
    return [];
  }

  return [];
}

function normalizeLocator(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return parseMaidenheadLocator(normalized) ? normalized : undefined;
}
