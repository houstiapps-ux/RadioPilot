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

const trendWeights = {
  volume: 0.5,
  grids: 0.3,
  calls: 0.2,
} as const;

const scoreWeights = {
  pskTrend: 0.45,
  gridSpread: 0.25,
  directionStrength: 0.2,
  solarSupport: 0.1,
} as const;

type DirectionBucket = (typeof supportedDirections)[number];

export interface BandPredictorRedisClient {
  get(key: string): Promise<string | null>;
}

export type DirectionalData = Readonly<Record<DirectionBucket, number>>;

export async function predictAllBands(
  redisClient: BandPredictorRedisClient,
): Promise<BandPredictionMap> {
  const solar = await loadSolar(redisClient);
  const predictions: Partial<Record<Band, BandPrediction>> = {};

  for (const band of supportedBands) {
    const [currentRaw, previousRaw, ...directionRaw] = await Promise.all([
      redisClient.get(`psk:band:${band}:current`),
      redisClient.get(`psk:band:${band}:previous`),
      ...supportedDirections.map((direction) => redisClient.get(`psk:band:${band}:dir:${direction}`)),
    ]);

    const current = parsePskBandWindow(currentRaw);
    const previous = parsePskBandWindow(previousRaw);

    if (!current && !previous) {
      continue;
    }

    const directionalData = Object.fromEntries(
      supportedDirections.map((direction, index) => [
        direction,
        parseDirectionCount(directionRaw[index]),
      ]),
    ) as Record<DirectionBucket, number>;

    predictions[band] = predictBandState(band, current, previous, directionalData, solar);
  }

  return predictions;
}

export function predictBandState(
  band: Band,
  current: PskBandWindowSummary | null,
  previous: PskBandWindowSummary | null,
  directionalData: DirectionalData,
  solar: SolarConditions | null,
): BandPrediction {
  const volumeDelta = ratioDelta(current?.count ?? 0, previous?.count ?? 0);
  const uniqueCallDelta = ratioDelta(current?.uniqueCalls ?? 0, previous?.uniqueCalls ?? 0);
  const uniqueGridDelta = ratioDelta(current?.uniqueGrids ?? 0, previous?.uniqueGrids ?? 0);

  const pskTrend = scorePskTrend(volumeDelta, uniqueGridDelta, uniqueCallDelta);
  const gridSpread = scoreGridSpread(uniqueGridDelta, uniqueCallDelta);
  const directionStrength = scoreDirectionStrength(directionalData);
  const solarSupport = scoreSolarSupport(band, solar);

  const score = clamp01(
    scoreWeights.pskTrend * pskTrend +
    scoreWeights.gridSpread * gridSpread +
    scoreWeights.directionStrength * directionStrength +
    scoreWeights.solarSupport * solarSupport,
  );

  const state = classifyBandState(score, volumeDelta, uniqueGridDelta);
  const signals = buildSignals(
    band,
    volumeDelta,
    uniqueGridDelta,
    directionStrength,
    solarSupport,
    state,
  );

  return {
    state,
    score: roundScore(score),
    volumeDelta: roundScore(volumeDelta),
    uniqueCallDelta: roundScore(uniqueCallDelta),
    gridDelta: roundScore(uniqueGridDelta),
    directionStrength: roundScore(directionStrength),
    solarSupport: roundScore(solarSupport),
    signals,
  };
}

// Backward-compatible export for existing callers that still pass a user profile.
export async function predictBandOpenings(
  redisClient: BandPredictorRedisClient,
  _userProfile?: { homeGrid?: string },
): Promise<BandPredictionMap> {
  return predictAllBands(redisClient);
}

export const computeBandPrediction = predictBandState;

async function loadSolar(redisClient: BandPredictorRedisClient): Promise<SolarConditions | null> {
  return (
    parseSolar(await redisClient.get("solar:current")) ??
    parseSolar(await redisClient.get("solar:latest"))
  );
}

function parseDirectionCount(value: string | null): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scorePskTrend(volumeDelta: number, gridDelta: number, callDelta: number): number {
  const weightedDelta =
    trendWeights.volume * volumeDelta +
    trendWeights.grids * gridDelta +
    trendWeights.calls * callDelta;

  if (volumeDelta >= 0.2 && gridDelta >= 0.1) {
    return clamp01(0.65 + weightedDelta * 0.35);
  }

  if (volumeDelta <= -0.2) {
    return clamp01(0.4 + weightedDelta * 0.4);
  }

  return clamp01(0.5 + weightedDelta * 0.3);
}

function scoreGridSpread(gridDelta: number, callDelta: number): number {
  return clamp01(0.45 + gridDelta * 0.35 + callDelta * 0.2);
}

function scoreDirectionStrength(directionalData: DirectionalData): number {
  const counts = Object.values(directionalData);
  const total = counts.reduce((sum, count) => sum + count, 0);

  if (total <= 0) {
    return 0.2;
  }

  const sorted = [...counts].sort((left, right) => right - left);
  const dominant = sorted[0] ?? 0;
  const runnerUp = sorted[1] ?? 0;
  const dominantRatio = dominant / total;
  const separation = (dominant - runnerUp) / total;

  return clamp01(0.25 + dominantRatio * 0.45 + separation * 0.3);
}

function scoreSolarSupport(band: Band, solar: SolarConditions | null): number {
  const muf = parseSolarMuf(solar?.muf);

  if (muf === null) {
    if (band === "20m") {
      return 0.5;
    }

    if (band === "40m" || band === "30m") {
      return 0.4;
    }

    return 0.2;
  }

  switch (band) {
    case "10m":
      return muf > 28 ? 0.9 : 0.1;
    case "12m":
      return muf > 24 ? 0.85 : 0.15;
    case "15m":
      return muf > 21 ? 0.8 : 0.2;
    case "17m":
      return muf > 18 ? 0.75 : 0.25;
    case "20m":
      return 0.5;
    case "30m":
    case "40m":
      return 0.35;
    default:
      return 0.25;
  }
}

function classifyBandState(
  score: number,
  volumeDelta: number,
  gridDelta: number,
): BandPrediction["state"] {
  if (score > 0.7 || (volumeDelta > 0.2 && gridDelta > 0.1)) {
    return "opening";
  }

  if (score < 0.4 || volumeDelta < -0.2) {
    return "fading";
  }

  return "stable";
}

function buildSignals(
  band: Band,
  volumeDelta: number,
  gridDelta: number,
  directionStrength: number,
  solarSupport: number,
  state: BandPrediction["state"],
): string[] {
  const signals: string[] = [];

  if (state === "opening") {
    signals.push(`${band} opening`);
  } else if (state === "fading") {
    signals.push(`${band} activity fading`);
  } else {
    signals.push(`${band} holding steady`);
  }

  if (volumeDelta > 0.15) {
    signals.push(`${band} activity rising`);
    signals.push("PSK volume rising");
  }

  if (gridDelta > 0.12) {
    signals.push("Digital grids increasing");
  }

  if (directionStrength >= 0.65) {
    signals.push("Directional PSK support");
  }

  if (solarSupport >= 0.6) {
    signals.push(`Solar supports ${band}`);
  }

  return signals;
}

function parseSolar(value: string | null): SolarConditions | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SolarConditions>;
    return typeof parsed === "object" && parsed !== null ? (parsed as SolarConditions) : null;
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

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
