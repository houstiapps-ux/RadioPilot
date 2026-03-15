import {
  deriveContinentFromMaidenhead,
  estimatePathBetweenLocators,
  lookupBand,
  parseMaidenheadLocator,
  type Band,
  type PskBandWindowSummary,
  type PskReporterReport,
  type PskReporterSummary,
} from "@radio-pilot/shared";
import mqtt, { type MqttClient } from "mqtt";

const defaultWindowMinutes = 15;
const defaultMqttUrl = "mqtt://mqtt.pskreporter.info";
const reconnectPeriodMs = 5_000;
const diagnosticsIntervalMs = 5_000;
const mockReportIntervalMs = 200;
const parserWatchdogWindowMs = 60_000;

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
const mockBands: readonly Band[] = ["10m", "12m", "15m", "17m", "20m", "30m", "40m"];
const mockGridPrefixes = ["IO", "FN", "JN", "PM", "QF", "FF", "IM", "KP"] as const;

export interface PskReporterMqttHandle {
  stop(): Promise<void>;
}

interface PskReporterMqttOptions {
  readonly windowMinutes?: number;
  readonly onSummary: (summary: PskReporterSummary) => Promise<void> | void;
  readonly onBandWindows?: (windows: {
    current: ReadonlyMap<Band, PskBandWindowSummary>;
    previous: ReadonlyMap<Band, PskBandWindowSummary>;
  }) => Promise<void> | void;
  readonly onDirectionalCounts?: (counts: PskReporterDirectionalCounts) => Promise<void> | void;
  readonly onMetrics?: (metrics: PskReporterWorkerMetrics) => Promise<void> | void;
  readonly onDiagnostic?: (event: string, details: Record<string, unknown>) => void;
}

export interface PskReporterWorkerMetrics {
  readonly mqttConnected: boolean;
  readonly parserHealthy: boolean;
  readonly messagesReceived: number;
  readonly reportsParsed: number;
  readonly reportsRetained: number;
  readonly malformedMessages: number;
  readonly droppedReports: Readonly<Record<string, number>>;
  readonly lastReportSecondsAgo: number | null;
  readonly messagesLast10s: number;
  readonly updatedAt: string;
}

interface PskReporterDiagnosticsState {
  receivedMessages: number;
  parsedReports: number;
  malformedMessages: number;
  dirtySummary: boolean;
  mqttConnected: boolean;
  recentMessageTimes: number[];
  sampledMessages: number;
  discardReasons: Record<string, number>;
  parserHealthy: boolean;
  parserAnomalySince: number | null;
  lastWatchdogWarningAt: number | null;
  lastWatchdogReceivedMessages: number;
  lastWatchdogParsedReports: number;
  loggedFirstParsedReport: boolean;
}

type DirectionBucket = NonNullable<ReturnType<typeof estimatePathBetweenLocators>>["direction"];

export type PskReporterDirectionalCounts = Readonly<Record<Band, Readonly<Record<DirectionBucket, number>>>>;

interface DirectionalAggregationState {
  currentBucketIndex: number;
  buckets: Array<Record<Band, Record<DirectionBucket, number>>>;
}

const directionalBuckets = 12;
const directionOrder: readonly DirectionBucket[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function startPskReporterMqttIngestion(
  options: PskReporterMqttOptions,
): PskReporterMqttHandle {
  const windowMinutes = options.windowMinutes ?? defaultWindowMinutes;
  const mqttUrl = process.env.PSK_REPORTER_MQTT_URL?.trim() || defaultMqttUrl;
  const useMock = process.env.MOCK_PSK?.trim().toLowerCase() === "true";
  const referenceGrid = normalizeGrid(
    process.env.PSK_REFERENCE_GRID?.trim() || process.env.HOME_GRID?.trim(),
  );
  const topics = buildPskReporterTopics();
  const recentReports: PskReporterReport[] = [];
  const directionalAggregation = createDirectionalAggregationState();
  const diagnostics: PskReporterDiagnosticsState = {
    receivedMessages: 0,
    parsedReports: 0,
    malformedMessages: 0,
    dirtySummary: false,
    mqttConnected: false,
    recentMessageTimes: [] as number[],
    sampledMessages: 0,
    discardReasons: {},
    parserHealthy: true,
    parserAnomalySince: null,
    lastWatchdogWarningAt: null,
    lastWatchdogReceivedMessages: 0,
    lastWatchdogParsedReports: 0,
    loggedFirstParsedReport: false,
  };
  const flushTimer = setInterval(() => {
    void flushSummary(
      recentReports,
      diagnostics,
      directionalAggregation,
      windowMinutes,
      referenceGrid,
      options,
    );
  }, diagnosticsIntervalMs);
  const client = useMock ? null : mqtt.connect(mqttUrl, {
    reconnectPeriod: reconnectPeriodMs,
    connectTimeout: 15_000,
    keepalive: 30,
  });
  const mockTimer = useMock
    ? setInterval(() => {
      const payload = Buffer.from(JSON.stringify(generateMockPskPayload()), "utf8");
      void handlePskReporterMessage(
        payload,
        "mock://psk",
        recentReports,
        diagnostics,
        directionalAggregation,
        referenceGrid,
        options,
      );
    }, mockReportIntervalMs)
    : undefined;

  if (useMock) {
    diagnostics.mqttConnected = true;
    options.onDiagnostic?.("psk-mock-start", {
      intervalMs: mockReportIntervalMs,
    });
  }

  if (client) {
    client.on("connect", () => {
      diagnostics.mqttConnected = true;
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
      diagnostics.mqttConnected = false;
      options.onDiagnostic?.("psk-reconnect", { mqttUrl });
    });

    client.on("error", (error) => {
      diagnostics.mqttConnected = false;
      console.error("PSK Reporter MQTT error", error);
    });

    client.on("close", () => {
      diagnostics.mqttConnected = false;
      options.onDiagnostic?.("psk-close", { mqttUrl });
    });

    client.on("message", (topic, payload) => {
      void handlePskReporterMessage(
        payload,
        topic,
        recentReports,
        diagnostics,
        directionalAggregation,
        referenceGrid,
        options,
      );
    });
  }

  return {
    async stop() {
      clearInterval(flushTimer);
      if (mockTimer !== undefined) {
        clearInterval(mockTimer);
      }

      if (client) {
        await endMqttClient(client);
      }
    },
  };
}

async function handlePskReporterMessage(
  payload: Buffer,
  topic: string,
  recentReports: PskReporterReport[],
  diagnostics: PskReporterDiagnosticsState,
  directionalAggregation: DirectionalAggregationState,
  referenceGrid: string | undefined,
  options: PskReporterMqttOptions,
): Promise<void> {
  diagnostics.receivedMessages += 1;
  diagnostics.recentMessageTimes.push(Date.now());
  const shouldSample = diagnostics.sampledMessages < 5;

  if (shouldSample) {
    diagnostics.sampledMessages += 1;
    options.onDiagnostic?.("psk-sample-message", {
      sampleIndex: diagnostics.sampledMessages,
      topic,
      payloadBytes: payload.byteLength,
      utf8Preview: payload.toString("utf8").slice(0, 240),
      hexPreview: payload.subarray(0, 64).toString("hex"),
    });
  }

  let parsedPayload: unknown;

  try {
    parsedPayload = JSON.parse(payload.toString("utf8")) as unknown;
  } catch (error) {
    diagnostics.malformedMessages += 1;
    incrementDiscardReason(diagnostics, "json_parse_failed");
    options.onDiagnostic?.("psk-malformed-message", {
      error: error instanceof Error ? error.message : String(error),
      topic,
      preview: payload.toString("utf8").slice(0, 120),
    });
    return;
  }

  const { reports, discardReasons } = parsePskReporterPayload(parsedPayload);

  for (const reason of discardReasons) {
    incrementDiscardReason(diagnostics, reason);
  }

  if (shouldSample) {
    options.onDiagnostic?.("psk-sample-parser-output", {
      topic,
      reportCount: reports.length,
      discardReasons,
      reportsPreview: reports.slice(0, 2),
    });
  }

  if (reports.length === 0) {
    return;
  }

  if (!diagnostics.loggedFirstParsedReport) {
    diagnostics.loggedFirstParsedReport = true;
    console.info("PSK Reporter first parsed report", JSON.stringify(reports[0]));
  }

  recentReports.push(...reports);
  diagnostics.parsedReports += reports.length;
  diagnostics.dirtySummary = true;
  if (referenceGrid) {
    updateDirectionalAggregation(directionalAggregation, referenceGrid, reports);
  }
}

async function flushSummary(
  recentReports: PskReporterReport[],
  diagnostics: PskReporterDiagnosticsState,
  directionalAggregation: DirectionalAggregationState,
  windowMinutes: number,
  referenceGrid: string | undefined,
  options: PskReporterMqttOptions,
): Promise<void> {
  const now = Date.now();
  pruneReports(recentReports, now, windowMinutes);
  pruneRecentMessageTimes(diagnostics.recentMessageTimes, now);
  updateParserWatchdog(diagnostics, now, options);

  options.onDiagnostic?.("psk-message-stats", {
    receivedMessages: diagnostics.receivedMessages,
    parsedReports: diagnostics.parsedReports,
    malformedMessages: diagnostics.malformedMessages,
    retainedReports: recentReports.length,
    discardReasons: diagnostics.discardReasons,
  });
  await options.onMetrics?.({
    mqttConnected: diagnostics.mqttConnected,
    parserHealthy: diagnostics.parserHealthy,
    messagesReceived: diagnostics.receivedMessages,
    reportsParsed: diagnostics.parsedReports,
    reportsRetained: recentReports.length,
    malformedMessages: diagnostics.malformedMessages,
    droppedReports: buildDroppedReports(diagnostics.discardReasons),
    lastReportSecondsAgo: getLastReportSecondsAgo(recentReports, now),
    messagesLast10s: diagnostics.recentMessageTimes.length,
    updatedAt: new Date(now).toISOString(),
  });
  await options.onBandWindows?.(buildPskBandWindowsFromReports(recentReports, now, windowMinutes));
  if (referenceGrid) {
    await options.onDirectionalCounts?.(sumDirectionalAggregation(directionalAggregation));
    rotateDirectionalAggregation(directionalAggregation);
  }

  if (!diagnostics.dirtySummary) {
    return;
  }

  const summary = buildPskReporterSummary(recentReports, now, windowMinutes);
  const hasParsedReports =
    diagnostics.parsedReports > 0 &&
    summary.bands.some((band) => band.currentWindowCount > 0 || band.previousWindowCount > 0);

  if (!hasParsedReports) {
    console.warn("PSK summary update skipped due to zero parsed reports");
    diagnostics.dirtySummary = false;
    return;
  }

  await options.onSummary(summary);
  diagnostics.dirtySummary = false;
  options.onDiagnostic?.("psk-summary-flush", {
    retainedReports: recentReports.length,
    bandCount: summary.bands.length,
    freshnessTimestamp: summary.freshnessTimestamp,
  });
}

export function parsePskReporterPayload(payload: unknown): {
  reports: PskReporterReport[];
  discardReasons: string[];
} {
  if (Array.isArray(payload)) {
    const discardReasons: string[] = [];
    return {
      reports: payload.flatMap((value) => normalizePskReporterRecord(value, discardReasons)),
      discardReasons,
    };
  }

  if (typeof payload === "object" && payload !== null) {
    const records = Reflect.get(payload, "reports");
    if (Array.isArray(records)) {
      const discardReasons: string[] = [];
      return {
        reports: records.flatMap((value) => normalizePskReporterRecord(value, discardReasons)),
        discardReasons,
      };
    }

    const discardReasons: string[] = [];
    return {
      reports: normalizePskReporterRecord(payload, discardReasons),
      discardReasons,
    };
  }

  return {
    reports: [],
    discardReasons: ["payload_not_array_or_object"],
  };
}

export function buildPskReporterTopics(): string[] {
  return supportedBands.flatMap((band) => [
    `pskr/filter/v2/${band}/FT8/+/+/+/+/+/+`,
    `pskr/filter/v2/${band}/FT4/+/+/+/+/+/+`,
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

function normalizePskReporterRecord(value: unknown, discardReasons: string[] = []): PskReporterReport[] {
  if (typeof value !== "object" || value === null) {
    discardReasons.push("record_not_object");
    return [];
  }

  const record = value as PskReporterRecord;
  const senderCallsign = normalizeCallsign(
    getString(record, ["sc", "txCallsign", "senderCallsign", "sender", "tx", "deCall"]),
  );
  const receiverCallsign = normalizeCallsign(
    getString(record, ["rc", "rxCallsign", "receiverCallsign", "receiver", "rx", "dxCall"]),
  );
  const senderLocator = normalizeGrid(getString(record, ["sl", "txGrid", "senderLocator", "txLocator", "deGrid"]));
  const receiverLocator = normalizeGrid(getString(record, ["rl", "rxGrid", "receiverLocator", "rxLocator", "dxGrid"]));
  const observedAt = normalizeObservedAt(record);
  const frequencyHz = normalizeFrequencyHz(record);

  if (!senderCallsign) {
    discardReasons.push("missing_sender_callsign");
  }

  if (!receiverCallsign) {
    discardReasons.push("missing_receiver_callsign");
  }

  if (!senderLocator) {
    discardReasons.push("missing_sender_locator");
  }

  if (!receiverLocator) {
    discardReasons.push("missing_receiver_locator");
  }

  if (!observedAt) {
    discardReasons.push("missing_observed_at");
  }

  if (!frequencyHz) {
    discardReasons.push("missing_frequency_hz");
  }

  if (!senderCallsign || !receiverCallsign || !senderLocator || !receiverLocator || !observedAt || !frequencyHz) {
    return [];
  }

  const band = normalizeBand(record);
  const mode = normalizeMode(getString(record, ["md", "mode", "modeName", "digitalMode"]));

  if (!supportedModes.has(mode)) {
    discardReasons.push(`unsupported_mode:${mode}`);
    return [];
  }

  if (!band || !supportedBands.includes(band)) {
    discardReasons.push(`unsupported_band:${band ?? "unknown"}`);
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

function incrementDiscardReason(
  diagnostics: PskReporterDiagnosticsState,
  reason: string,
): void {
  diagnostics.discardReasons[reason] = (diagnostics.discardReasons[reason] ?? 0) + 1;
}

function updateParserWatchdog(
  diagnostics: PskReporterDiagnosticsState,
  now: number,
  options: Pick<PskReporterMqttOptions, "onDiagnostic">,
): void {
  const receivedDelta = diagnostics.receivedMessages - diagnostics.lastWatchdogReceivedMessages;
  const parsedDelta = diagnostics.parsedReports - diagnostics.lastWatchdogParsedReports;

  diagnostics.lastWatchdogReceivedMessages = diagnostics.receivedMessages;
  diagnostics.lastWatchdogParsedReports = diagnostics.parsedReports;

  if (receivedDelta > 0 && parsedDelta === 0) {
    if (diagnostics.parserAnomalySince === null) {
      diagnostics.parserAnomalySince = now;
    }

    if (now - diagnostics.parserAnomalySince >= parserWatchdogWindowMs) {
      diagnostics.parserHealthy = false;

      if (
        diagnostics.lastWatchdogWarningAt === null ||
        now - diagnostics.lastWatchdogWarningAt >= parserWatchdogWindowMs
      ) {
        diagnostics.lastWatchdogWarningAt = now;
        console.warn("PSK ingestion anomaly: messages arriving but no reports parsed");
        options.onDiagnostic?.("psk-parser-anomaly", {
          messagesReceived: diagnostics.receivedMessages,
          reportsParsed: diagnostics.parsedReports,
          anomalySeconds: Math.round((now - diagnostics.parserAnomalySince) / 1000),
        });
      }
    }

    return;
  }

  if (parsedDelta > 0 || receivedDelta <= 0) {
    diagnostics.parserHealthy = true;
    diagnostics.parserAnomalySince = null;
  }
}

function buildDroppedReports(
  discardReasons: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  return {
    missingLocator:
      (discardReasons.missing_sender_locator ?? 0) +
      (discardReasons.missing_receiver_locator ?? 0),
    unknownBand:
      sumDiscardReasonsWithPrefix(discardReasons, "unsupported_band:"),
    unsupportedMode:
      sumDiscardReasonsWithPrefix(discardReasons, "unsupported_mode:"),
    invalidObservedAt: discardReasons.missing_observed_at ?? 0,
    invalidFrequency: discardReasons.missing_frequency_hz ?? 0,
    invalidCallsign:
      (discardReasons.missing_sender_callsign ?? 0) +
      (discardReasons.missing_receiver_callsign ?? 0),
    invalidPayload:
      (discardReasons.json_parse_failed ?? 0) +
      (discardReasons.payload_not_array_or_object ?? 0) +
      (discardReasons.record_not_object ?? 0),
  };
}

function sumDiscardReasonsWithPrefix(
  discardReasons: Readonly<Record<string, number>>,
  prefix: string,
): number {
  return Object.entries(discardReasons).reduce((total, [reason, count]) =>
    reason.startsWith(prefix) ? total + count : total, 0);
}

function getLastReportSecondsAgo(
  reports: readonly PskReporterReport[],
  now: number,
): number | null {
  const lastObservedAtMs = reports.reduce((latest, report) => {
    const observedAtMs = Date.parse(report.observedAt);
    return Number.isFinite(observedAtMs) && observedAtMs > latest ? observedAtMs : latest;
  }, Number.NEGATIVE_INFINITY);

  if (!Number.isFinite(lastObservedAtMs)) {
    return null;
  }

  return Math.max(0, Math.round((now - lastObservedAtMs) / 1000));
}

function getString(record: PskReporterRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = Reflect.get(record, key);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
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
  const bandValue = getString(record, ["b", "band"]);

  if (bandValue) {
    const normalizedBand = bandValue.trim() as Band;
    return supportedBands.includes(normalizedBand) ? normalizedBand : null;
  }

  const frequencyValue = getString(record, ["f", "frequency", "frequencyHz", "freq"]);

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
  const frequencyValue = getString(record, ["f", "frequency", "frequencyHz", "freq"]);

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
  const observedAt = getString(record, ["t_tx", "t", "observedAt", "flowStartSeconds", "timestamp", "time"]);

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

function buildPskBandWindowsFromReports(
  reports: readonly PskReporterReport[],
  now: number,
  windowMinutes: number,
): {
  current: ReadonlyMap<Band, PskBandWindowSummary>;
  previous: ReadonlyMap<Band, PskBandWindowSummary>;
} {
  const windowMs = windowMinutes * 60 * 1000;
  const currentWindowStart = now - windowMs;
  const previousWindowStart = currentWindowStart - windowMs;
  const currentReports = reports.filter((report) => {
    const observedAt = Date.parse(report.observedAt);
    return Number.isFinite(observedAt) && observedAt >= currentWindowStart && observedAt <= now;
  });
  const previousReports = reports.filter((report) => {
    const observedAt = Date.parse(report.observedAt);
    return Number.isFinite(observedAt) && observedAt >= previousWindowStart && observedAt < currentWindowStart;
  });

  return {
    current: summarizeReportsByBand(currentReports, now),
    previous: summarizeReportsByBand(previousReports, now),
  };
}

function summarizeReportsByBand(
  reports: readonly PskReporterReport[],
  now: number,
): ReadonlyMap<Band, PskBandWindowSummary> {
  const grouped = new Map<Band, PskReporterReport[]>();

  for (const report of reports) {
    if (!report.band) {
      continue;
    }

    const existing = grouped.get(report.band);

    if (existing) {
      existing.push(report);
    } else {
      grouped.set(report.band, [report]);
    }
  }

  const summary = new Map<Band, PskBandWindowSummary>();

  for (const band of supportedBands) {
    const bandReports = grouped.get(band) ?? [];

    summary.set(band, {
      count: bandReports.length,
      uniqueCalls: new Set(bandReports.map((report) => report.senderCallsign)).size,
      uniqueGrids: new Set(bandReports.map((report) => report.senderLocator)).size,
      modes: {
        FT8: bandReports.filter((report) => report.mode === "FT8").length,
        FT4: bandReports.filter((report) => report.mode === "FT4").length,
      },
      updatedAt: now,
    });
  }

  return summary;
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

function pruneRecentMessageTimes(messageTimes: number[], now: number): void {
  const cutoff = now - 10_000;

  for (let index = messageTimes.length - 1; index >= 0; index -= 1) {
    if (messageTimes[index] < cutoff) {
      messageTimes.splice(index, 1);
    }
  }
}

function generateMockPskPayload(): Record<string, unknown> {
  const band = pickRandom(mockBands);
  const frequencyHz = bandToMockFrequencyHz(band);

  return {
    senderCallsign: `MOCK${randomInt(100, 999)}`,
    receiverCallsign: `RX${randomInt(100, 999)}`,
    senderLocator: generateMockGrid(),
    receiverLocator: generateMockGrid(),
    mode: "FT8",
    frequency: String(frequencyHz),
    snr: String(randomInt(-25, 10)),
    observedAt: new Date().toISOString(),
  };
}

function generateMockGrid(): string {
  const prefix = pickRandom(mockGridPrefixes);
  const firstDigits = randomInt(0, 9);
  const secondDigits = randomInt(0, 9);
  const firstSuffix = String.fromCharCode(65 + randomInt(0, 23));
  const secondSuffix = String.fromCharCode(65 + randomInt(0, 23));
  return `${prefix}${firstDigits}${secondDigits}${firstSuffix}${secondSuffix}`;
}

function bandToMockFrequencyHz(band: Band): number {
  const centerFrequencies: Record<Band, number> = {
    "160m": 1840000,
    "80m": 3573000,
    "60m": 5357000,
    "40m": 7074000,
    "30m": 10136000,
    "20m": 14074000,
    "17m": 18100000,
    "15m": 21074000,
    "12m": 24915000,
    "10m": 28074000,
    "6m": 50313000,
    "2m": 144174000,
    "70cm": 432174000,
    "23cm": 1296541000,
  };

  return centerFrequencies[band];
}

function pickRandom<T>(values: readonly T[]): T {
  return values[randomInt(0, values.length - 1)];
}

function randomInt(min: number, max: number): number {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

function createDirectionalAggregationState(): DirectionalAggregationState {
  return {
    currentBucketIndex: 0,
    buckets: Array.from({ length: directionalBuckets }, () => createDirectionalCounterBucket()),
  };
}

function createDirectionalCounterBucket(): Record<Band, Record<DirectionBucket, number>> {
  return supportedBands.reduce<Record<Band, Record<DirectionBucket, number>>>((current, band) => {
    current[band] = directionOrder.reduce<Record<DirectionBucket, number>>((bandCounts, direction) => {
      bandCounts[direction] = 0;
      return bandCounts;
    }, {} as Record<DirectionBucket, number>);
    return current;
  }, {} as Record<Band, Record<DirectionBucket, number>>);
}

function updateDirectionalAggregation(
  aggregation: DirectionalAggregationState,
  referenceGrid: string,
  reports: readonly PskReporterReport[],
): void {
  const bucket = aggregation.buckets[aggregation.currentBucketIndex];

  for (const report of reports) {
    if (!report.band) {
      continue;
    }

    const estimate = estimatePathBetweenLocators(referenceGrid, report.senderLocator);

    if (!estimate) {
      continue;
    }

    bucket[report.band][estimate.direction] += 1;
  }
}

function sumDirectionalAggregation(
  aggregation: DirectionalAggregationState,
): PskReporterDirectionalCounts {
  const totals = createDirectionalCounterBucket();

  for (const bucket of aggregation.buckets) {
    for (const band of supportedBands) {
      for (const direction of directionOrder) {
        totals[band][direction] += bucket[band][direction];
      }
    }
  }

  return totals;
}

function rotateDirectionalAggregation(aggregation: DirectionalAggregationState): void {
  aggregation.currentBucketIndex = (aggregation.currentBucketIndex + 1) % aggregation.buckets.length;
  aggregation.buckets[aggregation.currentBucketIndex] = createDirectionalCounterBucket();
}

function endMqttClient(client: MqttClient): Promise<void> {
  return new Promise((resolve) => {
    client.end(true, {}, () => {
      resolve();
    });
  });
}
