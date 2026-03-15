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

type DirectionBucket = (typeof directions)[number];
type DirectionDensityMap = Readonly<Record<DirectionBucket, number>>;

export interface PathDensityRedisClient {
  get(key: string): Promise<string | null>;
}

export async function getBandPathDensity(
  redisClient: PathDensityRedisClient,
  band: Band,
): Promise<PropagationBandDensity> {
  const rawCounts = await Promise.all(
    directions.map((direction) => redisClient.get(`psk:band:${band}:dir:${direction}`)),
  );
  const counts = Object.fromEntries(
    directions.map((direction, index) => [direction, parseDirectionCount(rawCounts[index])]),
  ) as Record<DirectionBucket, number>;

  return computePropagationBandDensity(counts);
}

export async function getAllBandPathDensities(
  redisClient: PathDensityRedisClient,
): Promise<PropagationDensityMap> {
  const entries = await Promise.all(
    supportedBands.map(async (band) => [band, await getBandPathDensity(redisClient, band)] as const),
  );

  return Object.fromEntries(
    entries.filter(([, density]) => Object.keys(density.densities).length > 0),
  ) as PropagationDensityMap;
}

export function getDominantDirection(
  densityMap: DirectionDensityMap,
): Pick<PropagationBandDensity, "direction" | "dominantDirection" | "sector" | "confidence" | "heading" | "beamHeading"> {
  const sorted = [...directions].sort((left, right) => densityMap[right] - densityMap[left]);
  const strongest = sorted[0];
  const strongestDensity = densityMap[strongest];

  if (strongestDensity <= 0) {
    return {
      confidence: "Low",
      sector: null,
    };
  }

  const adjacentDirections = getAdjacentDirections(strongest)
    .map((direction) => ({ direction, density: densityMap[direction] }))
    .sort((left, right) => right.density - left.density);
  const adjacent = adjacentDirections[0];
  const hasSector = strongestDensity > 0.2 && adjacent.density >= 0.15;
  const sector = hasSector ? formatSector(strongest, adjacent.direction) : null;
  const heading = hasSector
    ? midpointHeading(directionDegrees[strongest], directionDegrees[adjacent.direction])
    : directionDegrees[strongest];

  let confidence: PropagationBandDensity["confidence"] = "Low";

  if (strongestDensity > 0.3) {
    confidence = "High";
  } else if (adjacent.density >= 0.15 && strongestDensity >= 0.15) {
    confidence = "Medium";
  }

  return {
    direction: strongestDensity > 0.2 ? strongest : undefined,
    dominantDirection: strongestDensity > 0.2 ? strongest : undefined,
    sector: sector ?? undefined,
    confidence,
    heading,
    beamHeading: heading,
  };
}

export function computePropagationBandDensity(
  counts: Readonly<Record<DirectionBucket, number>>,
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
  ) as Record<DirectionBucket, number>;
  const dominant = getDominantDirection(densities);

  return {
    direction: dominant.direction,
    dominantDirection: dominant.dominantDirection,
    sector: dominant.sector,
    confidence: dominant.confidence,
    heading: dominant.heading,
    beamHeading: dominant.beamHeading,
    densities,
  };
}

// Backward-compatible export used by the current API.
export async function getDirectionalPropagation(
  redisClient: PathDensityRedisClient,
  _userProfile?: { homeGrid?: string },
): Promise<PropagationDensityMap> {
  return getAllBandPathDensities(redisClient);
}

function parseDirectionCount(value: string | null): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getAdjacentDirections(direction: DirectionBucket): readonly DirectionBucket[] {
  const index = directions.indexOf(direction);
  const left = directions[(index - 1 + directions.length) % directions.length];
  const right = directions[(index + 1) % directions.length];
  return [left, right];
}

function formatSector(first: DirectionBucket, second: DirectionBucket): string {
  return [first, second]
    .sort((left, right) => directionDegrees[left] - directionDegrees[right])
    .join("-");
}

function midpointHeading(left: number, right: number): number {
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
