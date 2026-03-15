import {
  estimatePathBetweenLocators,
  lookupBand,
  parseMaidenheadLocator,
  type Band,
  type PskReporterReport,
  type PskReporterSummary,
} from "@radio-pilot/shared";

const httpTimeoutMs = 15_000;
const defaultWindowMinutes = 15;

type PskReporterRecord = Record<string, unknown>;
const supportedBands: readonly Band[] = [
  "160m",
  "80m",
  "60m",
  "40m",
  "30m",
  "20m",
  "17m",
  "15m",
  "12m",
  "10m",
  "6m",
  "2m",
];

export async function fetchPskReporterSummary(
  now: number = Date.now(),
): Promise<PskReporterSummary | null> {
  const url = process.env.PSK_REPORTER_URL?.trim();

  if (!url) {
    return null;
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(httpTimeoutMs) });

    if (!response.ok) {
      console.error(`PSK Reporter fetch failed: HTTP ${response.status} ${response.statusText}`);
      return null;
    }

    const payload = (await response.json()) as unknown;
    const reports = parsePskReporterPayload(payload);
    return buildPskReporterSummary(reports, now);
  } catch (error) {
    console.error("PSK Reporter fetch failed", error);
    return null;
  }
}

export function parsePskReporterPayload(payload: unknown): PskReporterReport[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((value) => normalizePskReporterRecord(value));
  }

  if (typeof payload === "object" && payload !== null) {
    const records = Reflect.get(payload, "reports");
    if (Array.isArray(records)) {
      return records.flatMap((value) => normalizePskReporterRecord(value));
    }
  }

  return [];
}

export function buildPskReporterSummary(
  reports: readonly PskReporterReport[],
  now: number = Date.now(),
  windowMinutes: number = defaultWindowMinutes,
): PskReporterSummary {
  const windowMs = windowMinutes * 60 * 1000;
  const currentWindowStart = now - windowMs;
  const previousWindowStart = currentWindowStart - windowMs;
  const currentReports = reports.filter((report) => {
    const observedAt = Date.parse(report.observedAt);
    return Number.isFinite(observedAt) && observedAt >= currentWindowStart && observedAt <= now;
  });
  const previousReports = reports.filter((report) => {
    const observedAt = Date.parse(report.observedAt);
    return Number.isFinite(observedAt) &&
      observedAt >= previousWindowStart &&
      observedAt < currentWindowStart;
  });
  const bandKeys = new Set<Band | "unknown">();

  for (const report of currentReports) {
    bandKeys.add(report.band ?? "unknown");
  }

  for (const report of previousReports) {
    bandKeys.add(report.band ?? "unknown");
  }

  const bands = [...bandKeys]
    .map((bandKey) => {
      const current = currentReports.filter((report) => (report.band ?? "unknown") === bandKey);
      const previous = previousReports.filter((report) => (report.band ?? "unknown") === bandKey);
      const directionCounts = countDirections(current);

      return {
        band: bandKey === "unknown" ? null : bandKey,
        reportCount: current.length,
        previousReportCount: previous.length,
        trend: current.length - previous.length,
        directionCounts,
      };
    })
    .sort((left, right) => {
      if (right.reportCount !== left.reportCount) {
        return right.reportCount - left.reportCount;
      }

      if (right.trend !== left.trend) {
        return right.trend - left.trend;
      }

      return (left.band ?? "").localeCompare(right.band ?? "");
    });

  return {
    generatedAt: new Date(now).toISOString(),
    currentWindowStart: new Date(currentWindowStart).toISOString(),
    previousWindowStart: new Date(previousWindowStart).toISOString(),
    windowMinutes,
    bands,
  };
}

function normalizePskReporterRecord(value: unknown): PskReporterReport[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as PskReporterRecord;
  const txCallsign = normalizeCallsign(
    getString(record, ["txCallsign", "senderCallsign", "sender", "tx", "deCall"]),
  );
  const rxCallsign = normalizeCallsign(
    getString(record, ["rxCallsign", "receiverCallsign", "receiver", "rx", "dxCall"]),
  );
  const txGrid = normalizeGrid(getString(record, ["txGrid", "senderLocator", "txLocator", "deGrid"]));
  const rxGrid = normalizeGrid(getString(record, ["rxGrid", "receiverLocator", "rxLocator", "dxGrid"]));
  const observedAt = normalizeObservedAt(record);

  if (!txCallsign || !rxCallsign || !txGrid || !rxGrid || !observedAt) {
    return [];
  }

  const band = normalizeBand(record);
  const mode = normalizeMode(getString(record, ["mode", "modeName", "digitalMode"]));

  return [{
    txCallsign,
    rxCallsign,
    txGrid,
    rxGrid,
    band,
    mode,
    observedAt,
  }];
}

function getString(record: PskReporterRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = Reflect.get(record, key);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function normalizeCallsign(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeGrid(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return parseMaidenheadLocator(normalized) ? normalized : undefined;
}

function normalizeMode(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : "unknown";
}

function normalizeBand(record: PskReporterRecord): PskReporterReport["band"] {
  const bandValue = getString(record, ["band"]);

  if (bandValue) {
    const normalizedBand = bandValue.trim() as Band;
    return supportedBands.includes(normalizedBand) ? normalizedBand : null;
  }

  const frequencyValue = getString(record, ["frequency", "frequencyHz", "freq"]);

  if (!frequencyValue) {
    return null;
  }

  const numericValue = Number.parseFloat(frequencyValue.replace(",", "."));

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  const frequencyKHz = numericValue > 100_000 ? numericValue / 1_000 : numericValue;
  return lookupBand(frequencyKHz);
}

function normalizeObservedAt(record: PskReporterRecord): string | undefined {
  const observedAt = getString(record, ["observedAt", "flowStartSeconds", "timestamp", "time"]);

  if (!observedAt) {
    return undefined;
  }

  if (/^\d+$/.test(observedAt)) {
    const numericValue = Number.parseInt(observedAt, 10);
    const milliseconds = numericValue > 10_000_000_000 ? numericValue : numericValue * 1_000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  const parsed = Date.parse(observedAt);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function countDirections(
  reports: readonly PskReporterReport[],
): Partial<Record<NonNullable<ReturnType<typeof estimatePathBetweenLocators>>["direction"], number>> {
  const counts: Partial<Record<NonNullable<ReturnType<typeof estimatePathBetweenLocators>>["direction"], number>> = {};

  for (const report of reports) {
    const estimate = estimatePathBetweenLocators(report.rxGrid, report.txGrid);

    if (!estimate) {
      continue;
    }

    counts[estimate.direction] = (counts[estimate.direction] ?? 0) + 1;
  }

  return counts;
}
