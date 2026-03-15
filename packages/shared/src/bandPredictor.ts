import type { Band } from "./bands.js";
import { parsePskBandWindow } from "./pskTrends.js";
import type {
  BandPrediction,
  BandPredictionMap,
  PskBandWindowSummary,
  SolarConditions,
} from "./types.js";

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
const supportedDirections = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export interface BandPredictorRedisClient {
  get(key: string): Promise<string | null>;
}

export interface BandPredictorUserProfile {
  readonly homeGrid?: string;
}

export async function predictBandOpenings(
  redisClient: BandPredictorRedisClient,
  _userProfile?: BandPredictorUserProfile,
): Promise<BandPredictionMap> {
  const solar = parseSolar(await redisClient.get("solar:current"))
    ?? parseSolar(await redisClient.get("solar:latest"));
  const lookups = supportedBands.flatMap((band) => [
    { band, kind: "current" as const, key: `psk:band:${band}:current` },
    { band, kind: "previous" as const, key: `psk:band:${band}:previous` },
    ...supportedDirections.map((direction) => ({
      band,
      kind: "direction" as const,
      direction,
      key: `psk:band:${band}:dir:${direction}`,
    })),
  ]);
  const values = await Promise.all(lookups.map((lookup) => redisClient.get(lookup.key)));
  const predictions: Partial<Record<Band, BandPrediction>> = {};

  for (const band of supportedBands) {
    const current = parsePskBandWindow(
      values[lookups.findIndex((lookup) => lookup.band === band && lookup.kind === "current")],
    );
    const previous = parsePskBandWindow(
      values[lookups.findIndex((lookup) => lookup.band === band && lookup.kind === "previous")],
    );
    const directionCounts = Object.fromEntries(
      supportedDirections.map((direction) => {
        const index = lookups.findIndex((lookup) =>
          lookup.band === band &&
          lookup.kind === "direction" &&
          lookup.direction === direction
        );
        const parsed = Number.parseInt(values[index] ?? "0", 10);
        return [direction, Number.isFinite(parsed) ? parsed : 0];
      }),
    ) as Record<(typeof supportedDirections)[number], number>;

    if (!current && !previous) {
      continue;
    }

    predictions[band] = computeBandPrediction(band, current, previous, directionCounts, solar);
  }

  return predictions;
}

export function computeBandPrediction(
  band: Band,
  current: PskBandWindowSummary | null,
  previous: PskBandWindowSummary | null,
  directionCounts: Readonly<Record<(typeof supportedDirections)[number], number>>,
  solar: SolarConditions | null,
): BandPrediction {
  const currentCount = current?.count ?? 0;
  const previousCount = previous?.count ?? 0;
  const volumeDelta = ratioDelta(currentCount, previousCount);
  const gridDelta = ratioDelta(current?.uniqueGrids ?? 0, previous?.uniqueGrids ?? 0);
  const callDelta = ratioDelta(current?.uniqueCalls ?? 0, previous?.uniqueCalls ?? 0);
  const pskTrend = clamp01(
    volumeDelta >= 0 ? 0.5 + volumeDelta * 0.5 : 0.5 + volumeDelta * 0.8,
  );
  const gridSpread = clamp01(
    gridDelta >= 0 ? 0.5 + gridDelta * 0.5 : 0.5 + gridDelta * 0.8,
  );
  const directionSignal = scoreDirectionSignal(directionCounts);
  const solarSupport = scoreSolarSupport(band, solar);
  const score = clamp01(
    0.45 * pskTrend +
    0.25 * gridSpread +
    0.20 * directionSignal +
    0.10 * solarSupport,
  );

  let state: BandPrediction["state"] = "stable";

  if (score > 0.7) {
    state = "opening";
  } else if (score < 0.4) {
    state = "fading";
  }

  const signals: string[] = [];

  if (volumeDelta > 0.15) {
    signals.push(`${band} activity rising`);
  } else if (volumeDelta < -0.15) {
    signals.push(`${band} activity easing`);
  }

  if (gridDelta > 0.12 || callDelta > 0.12) {
    signals.push("Digital grids increasing");
  }

  if (directionSignal >= 0.65) {
    signals.push("Directional PSK support");
  }

  if (solarSupport >= 0.6) {
    signals.push(`Solar conditions support ${band}`);
  }

  return {
    state,
    score: Math.round(score * 100) / 100,
    signals,
  };
}

function scoreDirectionSignal(
  directionCounts: Readonly<Record<(typeof supportedDirections)[number], number>>,
): number {
  const counts = Object.values(directionCounts).sort((left, right) => right - left);
  const dominant = counts[0] ?? 0;
  const runnerUp = counts[1] ?? 0;
  const total = counts.reduce((sum, count) => sum + count, 0);

  if (total <= 0) {
    return 0.2;
  }

  return clamp01(0.3 + (dominant - runnerUp) / Math.max(total, 1) + dominant / Math.max(total, 1) * 0.4);
}

function scoreSolarSupport(band: Band, solar: SolarConditions | null): number {
  const muf = parseSolarMuf(solar?.muf);

  if (band === "10m") {
    return muf !== null && muf > 28 ? 0.9 : 0.1;
  }

  if (band === "12m") {
    return muf !== null && muf > 24 ? 0.85 : 0.15;
  }

  if (band === "15m") {
    return muf !== null && muf > 21 ? 0.8 : 0.2;
  }

  if (band === "17m") {
    return muf !== null && muf > 18 ? 0.75 : 0.25;
  }

  if (band === "20m") {
    return 0.5;
  }

  return 0.35;
}

function parseSolar(value: string | null): SolarConditions | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as SolarConditions;
    return typeof parsed.updatedAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function parseSolarMuf(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function ratioDelta(current: number, previous: number): number {
  if (previous <= 0) {
    return current > 0 ? 1 : 0;
  }

  return (current - previous) / previous;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
