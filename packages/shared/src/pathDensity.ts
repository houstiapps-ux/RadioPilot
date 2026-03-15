import type { Band } from "./bands.js";
import type { PropagationBandDensity, PropagationDensityMap } from "./types.js";

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
const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const directionDegrees: Record<(typeof directions)[number], number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

export interface PathDensityRedisClient {
  get(key: string): Promise<string | null>;
}

export interface PathDensityUserProfile {
  readonly homeGrid?: string;
}

export async function getBandPathDensity(
  redisClient: PathDensityRedisClient,
  band: Band,
): Promise<PropagationBandDensity> {
  const entries = await Promise.all(
    directions.map(async (direction) => {
      const value = await redisClient.get(`psk:band:${band}:dir:${direction}`);
      const count = Number.parseInt(value ?? "0", 10);
      return [direction, Number.isFinite(count) ? count : 0] as const;
    }),
  );
  const counts = Object.fromEntries(entries) as Record<(typeof directions)[number], number>;
  return computePropagationBandDensity(counts);
}

export async function getDirectionalPropagation(
  redisClient: PathDensityRedisClient,
  _userProfile?: PathDensityUserProfile,
): Promise<PropagationDensityMap> {
  const byBand = await Promise.all(
    supportedBands.map(async (band) => [band, await getBandPathDensity(redisClient, band)] as const),
  );

  return Object.fromEntries(
    byBand.filter(([, density]) => Object.keys(density.densities).length > 0),
  ) as PropagationDensityMap;
}

export function computePropagationBandDensity(
  counts: Readonly<Record<(typeof directions)[number], number>>,
): PropagationBandDensity {
  const total = directions.reduce((sum, direction) => sum + (counts[direction] ?? 0), 0);

  if (total <= 0) {
    return {
      confidence: "Low",
      densities: {},
    };
  }

  const densities = Object.fromEntries(
    directions.map((direction) => [direction, roundDensity((counts[direction] ?? 0) / total)]),
  ) as Record<(typeof directions)[number], number>;
  const sortedDirections = [...directions].sort((left, right) => densities[right] - densities[left]);
  const dominantDirection = sortedDirections[0];
  const dominantDensity = densities[dominantDirection];
  let sector: string | undefined;
  let beamHeading = directionDegrees[dominantDirection];
  const adjacent = getAdjacentDirections(dominantDirection)
    .map((direction) => ({ direction, density: densities[direction] }))
    .sort((left, right) => right.density - left.density)[0];

  if (adjacent && dominantDensity > 0.2 && adjacent.density >= 0.15) {
    sector = formatSector(dominantDirection, adjacent.direction);
    beamHeading = averageDegrees(directionDegrees[dominantDirection], directionDegrees[adjacent.direction]);
  }

  let confidence: PropagationBandDensity["confidence"] = "Low";

  if (dominantDensity > 0.3) {
    confidence = "High";
  } else if (adjacent && dominantDensity >= 0.15 && adjacent.density >= 0.15) {
    confidence = "Medium";
  }

  return {
    dominantDirection: dominantDensity > 0.2 ? dominantDirection : undefined,
    sector,
    beamHeading,
    confidence,
    densities,
  };
}

function getAdjacentDirections(
  direction: (typeof directions)[number],
): readonly (typeof directions)[number][] {
  const index = directions.indexOf(direction);
  const left = directions[(index - 1 + directions.length) % directions.length];
  const right = directions[(index + 1) % directions.length];
  return [left, right];
}

function formatSector(
  first: (typeof directions)[number],
  second: (typeof directions)[number],
): string {
  return [first, second]
    .sort((left, right) => directionDegrees[left] - directionDegrees[right])
    .join("-");
}

function averageDegrees(left: number, right: number): number {
  const leftRadians = left * (Math.PI / 180);
  const rightRadians = right * (Math.PI / 180);
  const x = Math.cos(leftRadians) + Math.cos(rightRadians);
  const y = Math.sin(leftRadians) + Math.sin(rightRadians);
  const angle = Math.atan2(y, x) * (180 / Math.PI);

  return Math.round((angle + 360) % 360);
}

function roundDensity(value: number): number {
  return Math.round(value * 100) / 100;
}
