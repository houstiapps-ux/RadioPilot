import type { Band } from "./bands.js";
import type { PskBandTrend, PskBandTrendMap, PskBandWindowSummary } from "./types.js";

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

export interface PskTrendRedisClient {
  get(key: string): Promise<string | null>;
}

export function computeBandTrend(
  current: PskBandWindowSummary | null,
  previous: PskBandWindowSummary | null,
): PskBandTrend {
  const currentCount = current?.count ?? 0;
  const previousCount = previous?.count ?? 0;
  const currentCalls = current?.uniqueCalls ?? 0;
  const previousCalls = previous?.uniqueCalls ?? 0;
  const currentGrids = current?.uniqueGrids ?? 0;
  const previousGrids = previous?.uniqueGrids ?? 0;
  const volumeDelta = ratioDelta(currentCount, previousCount);
  const uniqueCallDelta = ratioDelta(currentCalls, previousCalls);
  const gridDelta = ratioDelta(currentGrids, previousGrids);

  let trend: PskBandTrend["trend"] = "steady";

  // Keep the trend rules simple and deterministic. Require both volume and spread
  // growth for the strongest positive signal, and a material drop for falling.
  if (
    (currentCount >= previousCount + 12 && volumeDelta >= 0.2) ||
    (volumeDelta >= 0.15 && gridDelta >= 0.15)
  ) {
    trend = "rising";
  } else if (
    (previousCount >= currentCount + 12 && volumeDelta <= -0.2) ||
    (volumeDelta <= -0.15 && gridDelta <= -0.1)
  ) {
    trend = "falling";
  }

  let confidence: PskBandTrend["confidence"] = "Low";

  if (
    Math.abs(volumeDelta) >= 0.3 &&
    Math.abs(gridDelta) >= 0.2 &&
    (currentCount >= 30 || previousCount >= 30)
  ) {
    confidence = "High";
  } else if (
    Math.abs(volumeDelta) >= 0.12 ||
    Math.abs(gridDelta) >= 0.12 ||
    Math.abs(uniqueCallDelta) >= 0.12
  ) {
    confidence = "Medium";
  }

  return {
    trend,
    volumeDelta,
    uniqueCallDelta,
    gridDelta,
    confidence,
  };
}

export async function getAllBandTrends(
  redis: PskTrendRedisClient,
): Promise<PskBandTrendMap> {
  const lookups = supportedBands.flatMap((band) => ([
    { band, key: `psk:band:${band}:current`, window: "current" as const },
    { band, key: `psk:band:${band}:previous`, window: "previous" as const },
  ]));
  const values = await Promise.all(lookups.map((lookup) => redis.get(lookup.key)));
  const grouped = new Map<Band, { current: PskBandWindowSummary | null; previous: PskBandWindowSummary | null }>();

  for (const band of supportedBands) {
    grouped.set(band, { current: null, previous: null });
  }

  lookups.forEach((lookup, index) => {
    grouped.get(lookup.band)![lookup.window] = parsePskBandWindow(values[index]);
  });

  const trends: Partial<Record<Band, PskBandTrend>> = {};

  for (const band of supportedBands) {
    const windows = grouped.get(band);

    if (!windows || (!windows.current && !windows.previous)) {
      continue;
    }

    trends[band] = computeBandTrend(windows.current, windows.previous);
  }

  return trends;
}

export function parsePskBandWindow(value: string | null): PskBandWindowSummary | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<PskBandWindowSummary>;

    if (
      typeof parsed.count === "number" &&
      typeof parsed.uniqueCalls === "number" &&
      typeof parsed.uniqueGrids === "number" &&
      typeof parsed.updatedAt === "number" &&
      typeof parsed.modes === "object" &&
      parsed.modes !== null
    ) {
      return {
        count: parsed.count,
        uniqueCalls: parsed.uniqueCalls,
        uniqueGrids: parsed.uniqueGrids,
        modes: {
          FT8: typeof parsed.modes.FT8 === "number" ? parsed.modes.FT8 : 0,
          FT4: typeof parsed.modes.FT4 === "number" ? parsed.modes.FT4 : 0,
        },
        updatedAt: parsed.updatedAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function ratioDelta(current: number, previous: number): number {
  if (previous <= 0) {
    return current > 0 ? 1 : 0;
  }

  return (current - previous) / previous;
}
