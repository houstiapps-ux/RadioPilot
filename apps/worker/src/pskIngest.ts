import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mqtt, { type MqttClient } from "mqtt";
import { createClient } from "redis";

import { lookupBand, parseMaidenheadLocator, type Band } from "@radio-pilot/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

const mqttUrl = "mqtt://mqtt.pskreporter.info:1883";
const mqttTopic = "#";
const flushIntervalMs = 5_000;
const trackedBands = ["10m", "12m", "15m", "17m", "20m", "30m", "40m"] as const;

type TrackedBand = (typeof trackedBands)[number];
type BandActivity = Record<TrackedBand, number>;
type PskPayload = Record<string, unknown>;

interface NormalizedPskReport {
  readonly senderLocator: string;
  readonly receiverLocator: string;
  readonly mode: string;
  readonly frequencyHz: number;
  readonly snr?: number;
  readonly band: TrackedBand;
}

interface RedisWriter {
  set(key: string, value: string): Promise<unknown>;
}

const initialBandActivity = (): BandActivity => ({
  "10m": 0,
  "12m": 0,
  "15m": 0,
  "17m": 0,
  "20m": 0,
  "30m": 0,
  "40m": 0,
});

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const redis = createClient({ url: redisUrl });
  redis.on("error", (err) => {
    console.error("Redis error", err);
  });
  const bandActivity = initialBandActivity();
  let lastMessageAt: string | null = null;

  console.info(`PSK ingest connecting to Redis at ${redactRedisUrl(redisUrl)}`);
  await redis.connect();
  console.info("PSK ingest Redis connected");

  const client = mqtt.connect(mqttUrl, {
    reconnectPeriod: 5_000,
    connectTimeout: 15_000,
    keepalive: 30,
  });

  const flushTimer = setInterval(() => {
    void flushCounters(redis, bandActivity, lastMessageAt);
  }, flushIntervalMs);

  client.on("connect", () => {
    console.info(`PSK ingest MQTT connected to ${mqttUrl}`);
    client.subscribe(mqttTopic, (error) => {
      if (error) {
        console.error("PSK ingest MQTT subscribe failed", error);
        return;
      }

      console.info(`PSK ingest subscribed to ${mqttTopic}`);
    });
  });

  client.on("reconnect", () => {
    console.warn("PSK ingest MQTT reconnecting");
  });

  client.on("error", (error) => {
    console.error("PSK ingest MQTT error", error);
  });

  client.on("message", (_topic, payload) => {
    const report = parsePskMessage(payload);

    if (!report) {
      return;
    }

    bandActivity[report.band] += 1;
    lastMessageAt = new Date().toISOString();
  });

  const shutdown = async () => {
    clearInterval(flushTimer);
    await flushCounters(redis, bandActivity, lastMessageAt);
    await endMqttClient(client);
    await redis.quit();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

function parsePskMessage(payload: Buffer): NormalizedPskReport | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    return null;
  }

  const records = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray(Reflect.get(parsed, "reports"))
      ? Reflect.get(parsed, "reports") as unknown[]
      : [parsed];

  for (const record of records) {
    const normalized = normalizeReport(record);

    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeReport(value: unknown): NormalizedPskReport | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as PskPayload;
  const senderCallsign = getString(record, [
    "sc",
    "senderCallsign",
    "txCallsign",
    "sender",
    "tx",
    "deCall",
  ]);
  const receiverCallsign = getString(record, [
    "rc",
    "receiverCallsign",
    "rxCallsign",
    "receiver",
    "rx",
    "dxCall",
  ]);
  const senderLocator = normalizeLocator(getString(record, [
    "sl",
    "senderLocator",
    "txLocator",
    "txGrid",
    "deGrid",
  ]));
  const receiverLocator = normalizeLocator(getString(record, [
    "rl",
    "receiverLocator",
    "rxLocator",
    "rxGrid",
    "dxGrid",
  ]));

  if (!senderCallsign || !receiverCallsign || !senderLocator || !receiverLocator) {
    return null;
  }

  const mode = normalizeMode(getString(record, ["md", "mode", "modeName", "digitalMode"]));
  const frequencyHz = normalizeFrequencyHz(record);

  if (!mode || frequencyHz === null) {
    return null;
  }

  const band = normalizeTrackedBand(record, frequencyHz);

  if (!band) {
    return null;
  }

  return {
    senderLocator,
    receiverLocator,
    mode,
    frequencyHz,
    snr: normalizeNumber(getString(record, ["snr", "db", "signalToNoise"])),
    band,
  };
}

function normalizeTrackedBand(record: PskPayload, frequencyHz: number): TrackedBand | null {
  const rawBand = getString(record, ["b", "band"]);

  if (rawBand) {
    return isTrackedBand(rawBand) ? rawBand : null;
  }

  const lookup = lookupBand(frequencyHz / 1_000);
  return lookup && isTrackedBand(lookup) ? lookup : null;
}

function normalizeFrequencyHz(record: PskPayload): number | null {
  const value = getString(record, ["f", "frequency", "frequencyHz", "freq"]);

  if (!value) {
    return null;
  }

  const numericValue = Number.parseFloat(value.replace(",", "."));

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue >= 100_000 ? numericValue : numericValue * 1_000;
}

function normalizeLocator(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return parseMaidenheadLocator(normalized) ? normalized : null;
}

function normalizeMode(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numericValue = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function getString(record: PskPayload, keys: readonly string[]): string | undefined {
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

async function flushCounters(
  redis: RedisWriter,
  bandActivity: BandActivity,
  lastMessageAt: string | null,
): Promise<void> {
  const summary = trackedBands.reduce<Record<string, number>>((current, band) => {
    if (bandActivity[band] > 0) {
      current[band] = bandActivity[band];
    }

    return current;
  }, {});

  await Promise.all([
    redis.set("psk:summary", JSON.stringify(summary)),
    redis.set("psk:freshness", lastMessageAt ?? new Date().toISOString()),
  ]);
}

function isTrackedBand(value: string): value is TrackedBand {
  return trackedBands.includes(value as TrackedBand);
}

function redactRedisUrl(value: string): string {
  try {
    const url = new URL(value);

    if (url.password) {
      url.password = "***";
    }

    return url.toString();
  } catch {
    return value;
  }
}

function endMqttClient(client: MqttClient): Promise<void> {
  return new Promise((resolve) => {
    client.end(true, {}, () => {
      resolve();
    });
  });
}

void main().catch((error) => {
  console.error("PSK ingest worker failed", error);
  process.exit(1);
});
