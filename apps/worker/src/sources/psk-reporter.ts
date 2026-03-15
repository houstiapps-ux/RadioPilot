import {
  deriveContinentFromMaidenhead,
  estimatePathBetweenLocators,
  lookupBand,
  parseMaidenheadLocator,
  type Band,
  type PskReporterReport,
  type PskReporterSummary,
} from "@radio-pilot/shared";
import mqtt, { type MqttClient } from "mqtt";

const defaultWindowMinutes = 15;
const defaultMqttUrl = "mqtt://mqtt.pskreporter.info";
const reconnectPeriodMs = 5_000;

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
const supportedModes = new Set(["FT8", "FT4"]);

export interface PskReporterMqttHandle {
  stop(): Promise<void>;
}

interface PskReporterMqttOptions {
  readonly windowMinutes?: number;
  readonly onSummary: (summary: PskReporterSummary) => Promise<void> | void;
  readonly onDiagnostic?: (event: string, details: Record<string, unknown>) => void;
}

export function startPskReporterMqttIngestion(
  options: PskReporterMqttOptions,
): PskReporterMqttHandle {
  const windowMinutes = options.windowMinutes ?? defaultWindowMinutes;
  const mqttUrl = process.env.PSK_REPORTER_MQTT_URL?.trim() || defaultMqttUrl;
  const topics = buildPskReporterTopics();
  const recentReports: PskReporterReport[] = [];
  const client = mqtt.connect(mqttUrl, {
    reconnectPeriod: reconnectPeriodMs,
    connectTimeout: 15_000,
    keepalive: 30,
  });

  client.on("connect", () => {
    options.onDiagnostic?.("psk-connect", {
      mqttUrl,
      topicCount: topics.length,
    });

    for (const topic of topics) {
      client.subscribe(topic, (error) => {
        if (error) {
          console.error("PSK Reporter subscribe failed", { topic, error });
          return;
        }

        options.onDiagnostic?.("psk-subscribe", { topic });
      });
    }
  });

  client.on("reconnect", () => {
    options.onDiagnostic?.("psk-reconnect", { mqttUrl });
  });

  client.on("error", (error) => {
    console.error("PSK Reporter MQTT error", error);
  });

  client.on("message", (_topic, payload) => {
    void handlePskReporterMessage(payload, recentReports, windowMinutes, options);
  });

  return {
    async stop() {
      await endMqttClient(client);
    },
  };
}

async function handlePskReporterMessage(
  payload: Buffer,
  recentReports: PskReporterReport[],
  windowMinutes: number,
  options: PskReporterMqttOptions,
): Promise<void> {
  let parsedPayload: unknown;

  try {
    parsedPayload = JSON.parse(payload.toString("utf8")) as unknown;
  } catch (error) {
    options.onDiagnostic?.("psk-malformed-message", {
      error: error instanceof Error ? error.message : String(error),
      preview: payload.toString("utf8").slice(0, 120),
    });
    return;
  }

  const reports = parsePskReporterPayload(parsedPayload);

  if (reports.length === 0) {
    return;
  }

  recentReports.push(...reports);
  pruneReports(recentReports, Date.now(), windowMinutes);
  const summary = buildPskReporterSummary(recentReports, Date.now(), windowMinutes);
  await options.onSummary(summary);
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

    return normalizePskReporterRecord(payload);
  }

  return [];
}

export function buildPskReporterTopics(): string[] {
  return supportedBands.flatMap((band) => [
    `pskr/filter/v2/${band}/FT8/#`,
    `pskr/filter/v2/${band}/FT4/#`,
  ]);
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
      const modeCounts = countModes(current);
      const directionCounts = countDirections(current);
      const pathCounts = countPaths(current);
      const uniqueSenderLocatorCount = new Set(current.map((report) => report.senderLocator)).size;
      const uniqueReceiverLocatorCount = new Set(current.map((report) => report.receiverLocator)).size;

      return {
        band: bandKey === "unknown" ? null : bandKey,
        currentWindowCount: current.length,
        previousWindowCount: previous.length,
        trend: current.length - previous.length,
        modeCounts,
        directionCounts,
        pathCounts,
        uniqueSenderLocatorCount,
        uniqueReceiverLocatorCount,
      };
    })
    .sort((left, right) => {
      if (right.currentWindowCount !== left.currentWindowCount) {
        return right.currentWindowCount - left.currentWindowCount;
      }

      if (right.trend !== left.trend) {
        return right.trend - left.trend;
      }

      return (left.band ?? "").localeCompare(right.band ?? "");
    });

  return {
    generatedAt: new Date(now).toISOString(),
    freshnessTimestamp: latestObservedAt(reports) ?? new Date(now).toISOString(),
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
  const senderCallsign = normalizeCallsign(
    getString(record, ["txCallsign", "senderCallsign", "sender", "tx", "deCall"]),
  );
  const receiverCallsign = normalizeCallsign(
    getString(record, ["rxCallsign", "receiverCallsign", "receiver", "rx", "dxCall"]),
  );
  const senderLocator = normalizeGrid(getString(record, ["txGrid", "senderLocator", "txLocator", "deGrid"]));
  const receiverLocator = normalizeGrid(getString(record, ["rxGrid", "receiverLocator", "rxLocator", "dxGrid"]));
  const observedAt = normalizeObservedAt(record);
  const frequencyHz = normalizeFrequencyHz(record);

  if (!senderCallsign || !receiverCallsign || !senderLocator || !receiverLocator || !observedAt || !frequencyHz) {
    return [];
  }

  const band = normalizeBand(record);
  const mode = normalizeMode(getString(record, ["mode", "modeName", "digitalMode"]));

  if (!supportedModes.has(mode)) {
    return [];
  }

  if (!band || !supportedBands.includes(band)) {
    return [];
  }

  return [{
    observedAt,
    frequencyHz,
    band,
    mode,
    senderCallsign,
    senderLocator,
    receiverCallsign,
    receiverLocator,
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

function normalizeFrequencyHz(record: PskReporterRecord): number | undefined {
  const frequencyValue = getString(record, ["frequency", "frequencyHz", "freq"]);

  if (!frequencyValue) {
    return undefined;
  }

  const numericValue = Number.parseFloat(frequencyValue.replace(",", "."));

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return undefined;
  }

  return numericValue > 100_000 ? numericValue : Math.round(numericValue * 1_000);
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
    const estimate = estimatePathBetweenLocators(report.receiverLocator, report.senderLocator);

    if (!estimate) {
      continue;
    }

    counts[estimate.direction] = (counts[estimate.direction] ?? 0) + 1;
  }

  return counts;
}

function countModes(reports: readonly PskReporterReport[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const report of reports) {
    counts[report.mode] = (counts[report.mode] ?? 0) + 1;
  }

  return counts;
}

function countPaths(reports: readonly PskReporterReport[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const report of reports) {
    const senderContinent = deriveContinentFromMaidenhead(report.senderLocator);
    const receiverContinent = deriveContinentFromMaidenhead(report.receiverLocator);

    if (!senderContinent || !receiverContinent) {
      continue;
    }

    const pathKey = `${senderContinent}->${receiverContinent}`;
    counts[pathKey] = (counts[pathKey] ?? 0) + 1;
  }

  return counts;
}

function latestObservedAt(reports: readonly PskReporterReport[]): string | undefined {
  const timestamps = reports
    .map((report) => Date.parse(report.observedAt))
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) {
    return undefined;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function pruneReports(
  reports: PskReporterReport[],
  now: number,
  windowMinutes: number,
): void {
  const retentionCutoff = now - (windowMinutes * 2 * 60 * 1_000);

  for (let index = reports.length - 1; index >= 0; index -= 1) {
    const observedAt = Date.parse(reports[index]?.observedAt ?? "");

    if (!Number.isFinite(observedAt) || observedAt < retentionCutoff) {
      reports.splice(index, 1);
    }
  }
}

function endMqttClient(client: MqttClient): Promise<void> {
  return new Promise((resolve) => {
    client.end(true, {}, () => {
      resolve();
    });
  });
}
