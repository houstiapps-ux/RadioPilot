import { lookupBand, parseMaidenheadLocator, type ActivationRecord } from "@radio-pilot/shared";

const httpTimeoutMs = 15_000;

type SotaRecord = Record<string, unknown>;

export async function fetchSotaActivations(): Promise<ActivationRecord[]> {
  const url = process.env.SOTA_URL?.trim();

  if (!url) {
    return [];
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(httpTimeoutMs) });

    if (!response.ok) {
      console.error(`SOTA fetch failed: HTTP ${response.status} ${response.statusText}`);
      return [];
    }

    return parseSotaPayload((await response.json()) as unknown);
  } catch (error) {
    console.error("SOTA fetch failed", error);
    return [];
  }
}

export function parseSotaPayload(payload: unknown): ActivationRecord[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((value) => normalizeSotaRecord(value));
  }

  if (typeof payload === "object" && payload !== null) {
    const activations = Reflect.get(payload, "activations");
    if (Array.isArray(activations)) {
      return activations.flatMap((value) => normalizeSotaRecord(value));
    }
  }

  return [];
}

function normalizeSotaRecord(value: unknown): ActivationRecord[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as SotaRecord;
  const reference = getString(record, ["reference", "summitCode", "summit"]);
  const callsign = getString(record, ["callsign", "activatorCallsign", "operator"]);
  const observedAt = normalizeObservedAt(getString(record, ["observedAt", "time", "timestamp", "startTime"]));

  if (!reference || !callsign || !observedAt) {
    return [];
  }

  return [{
    id: `sota:${reference}:${callsign}:${observedAt}`,
    programme: "SOTA",
    reference: reference.toUpperCase(),
    callsign: callsign.toUpperCase(),
    band: normalizeBand(record),
    mode: normalizeOptional(getString(record, ["mode"])),
    locator: normalizeLocator(getString(record, ["locator", "grid", "maidenhead"])),
    latitude: normalizeNumber(record, ["latitude", "lat"]),
    longitude: normalizeNumber(record, ["longitude", "lon", "lng"]),
    observedAt,
  }];
}

function getString(record: SotaRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = Reflect.get(record, key);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function normalizeObservedAt(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }

  if (/^\d+$/.test(value)) {
    const numericValue = Number.parseInt(value, 10);
    const milliseconds = numericValue > 10_000_000_000 ? numericValue : numericValue * 1_000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  return undefined;
}

function normalizeBand(record: SotaRecord): ActivationRecord["band"] {
  const band = getString(record, ["band"]);
  if (band) {
    return band as ActivationRecord["band"];
  }

  const frequency = getString(record, ["frequency", "frequencyKHz", "freq"]);
  if (!frequency) {
    return null;
  }

  const numericValue = Number.parseFloat(frequency.replace(",", "."));
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return lookupBand(numericValue > 100_000 ? numericValue / 1_000 : numericValue);
}

function normalizeLocator(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return parseMaidenheadLocator(normalized) ? normalized : undefined;
}

function normalizeNumber(record: SotaRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = Reflect.get(record, key);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const numericValue = Number.parseFloat(value);
      if (Number.isFinite(numericValue)) {
        return numericValue;
      }
    }
  }

  return undefined;
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}
