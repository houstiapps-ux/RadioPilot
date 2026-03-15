export type ContinentCode = "AF" | "AN" | "AS" | "EU" | "NA" | "OC" | "SA";

export interface ParsedMaidenheadLocator {
  readonly normalized: string;
  readonly precision: 2 | 4 | 6 | 8;
}

export interface MaidenheadCoordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export interface MaidenheadPathEstimate {
  readonly distanceKm: number;
  readonly bearingDegrees: number;
  readonly direction: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
}

const letterPattern = /^[A-Z]+$/;
const digitPattern = /^\d+$/;
const longitudeSteps = [20, 2, 5 / 60, 0.5 / 60] as const;
const latitudeSteps = [10, 1, 2.5 / 60, 0.25 / 60] as const;

export function parseMaidenheadLocator(locator: string): ParsedMaidenheadLocator | null {
  const normalized = locator.trim().toUpperCase();

  if (normalized.length < 2 || normalized.length > 8 || normalized.length % 2 !== 0) {
    return null;
  }

  const pairs = normalized.length / 2;

  for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
    const pair = normalized.slice(pairIndex * 2, pairIndex * 2 + 2);

    if (pairIndex === 0) {
      if (!letterPattern.test(pair) || pair[0] > "R" || pair[1] > "R") {
        return null;
      }

      continue;
    }

    if (pairIndex % 2 === 1) {
      if (!digitPattern.test(pair)) {
        return null;
      }

      continue;
    }

    if (!letterPattern.test(pair) || pair[0] > "X" || pair[1] > "X") {
      return null;
    }
  }

  return {
    normalized,
    precision: normalized.length as ParsedMaidenheadLocator["precision"],
  };
}

export function maidenheadToLatLon(locator: string): MaidenheadCoordinates | null {
  const parsed = parseMaidenheadLocator(locator);

  if (!parsed) {
    return null;
  }

  let longitude = -180;
  let latitude = -90;
  let longitudeStep: number = longitudeSteps[0];
  let latitudeStep: number = latitudeSteps[0];
  const pairs = parsed.normalized.length / 2;

  for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
    const pair = parsed.normalized.slice(pairIndex * 2, pairIndex * 2 + 2);

    if (pairIndex === 0) {
      longitudeStep = longitudeSteps[0];
      latitudeStep = latitudeSteps[0];
      longitude += (pair.charCodeAt(0) - 65) * longitudeStep;
      latitude += (pair.charCodeAt(1) - 65) * latitudeStep;
      continue;
    }

    if (pairIndex % 2 === 1) {
      longitudeStep = longitudeSteps[pairIndex];
      latitudeStep = latitudeSteps[pairIndex];
      longitude += Number.parseInt(pair[0], 10) * longitudeStep;
      latitude += Number.parseInt(pair[1], 10) * latitudeStep;
      continue;
    }

    longitudeStep = longitudeSteps[pairIndex];
    latitudeStep = latitudeSteps[pairIndex];
    longitude += (pair.charCodeAt(0) - 65) * longitudeStep;
    latitude += (pair.charCodeAt(1) - 65) * latitudeStep;
  }

  return {
    latitude: latitude + latitudeStep / 2,
    longitude: longitude + longitudeStep / 2,
  };
}

export function deriveContinentFromLatLon(
  coordinates: MaidenheadCoordinates,
): ContinentCode | undefined {
  const { latitude, longitude } = coordinates;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return undefined;
  }

  if (latitude <= -60) {
    return "AN";
  }

  if (latitude >= 35 && latitude <= 72 && longitude >= -25 && longitude < 45) {
    return "EU";
  }

  if (latitude >= -35 && latitude < 38 && longitude >= -20 && longitude < 55) {
    return "AF";
  }

  if (latitude >= 7 && longitude >= -170 && longitude < -20) {
    return "NA";
  }

  if (latitude < 15 && latitude >= -60 && longitude >= -100 && longitude < -30) {
    return "SA";
  }

  if (latitude >= -50 && latitude < 10 && (longitude >= 110 || longitude < -120)) {
    return "OC";
  }

  if (latitude >= 0 && latitude <= 82 && longitude >= 45 && longitude <= 180) {
    return "AS";
  }

  if (latitude >= -10 && latitude < 10 && longitude >= 55 && longitude < 110) {
    return "AS";
  }

  return undefined;
}

export function deriveContinentFromMaidenhead(locator: string): ContinentCode | undefined {
  const coordinates = maidenheadToLatLon(locator);
  return coordinates ? deriveContinentFromLatLon(coordinates) : undefined;
}

export function estimatePathBetweenLocators(
  fromLocator: string,
  toLocator: string,
): MaidenheadPathEstimate | undefined {
  const from = maidenheadToLatLon(fromLocator);
  const to = maidenheadToLatLon(toLocator);

  if (!from || !to) {
    return undefined;
  }

  const distanceKm = haversineDistanceKm(from, to);
  const bearingDegrees = initialBearingDegrees(from, to);

  return {
    distanceKm,
    bearingDegrees,
    direction: bearingToDirectionBucket(bearingDegrees),
  };
}

export function bearingBetweenLocators(
  fromLocator: string,
  toLocator: string,
): number | undefined {
  const estimate = estimatePathBetweenLocators(fromLocator, toLocator);
  return estimate?.bearingDegrees;
}

function haversineDistanceKm(
  from: MaidenheadCoordinates,
  to: MaidenheadCoordinates,
): number {
  const earthRadiusKm = 6_371;
  const lat1 = degreesToRadians(from.latitude);
  const lat2 = degreesToRadians(to.latitude);
  const deltaLat = degreesToRadians(to.latitude - from.latitude);
  const deltaLon = degreesToRadians(to.longitude - from.longitude);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const a = sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusKm * c;
}

function initialBearingDegrees(
  from: MaidenheadCoordinates,
  to: MaidenheadCoordinates,
): number {
  const lat1 = degreesToRadians(from.latitude);
  const lat2 = degreesToRadians(to.latitude);
  const deltaLon = degreesToRadians(to.longitude - from.longitude);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  const bearing = radiansToDegrees(Math.atan2(y, x));

  return (bearing + 360) % 360;
}

export function bearingToDirectionBucket(
  bearingDegrees: number,
): MaidenheadPathEstimate["direction"] {
  const directions: readonly MaidenheadPathEstimate["direction"][] = [
    "N",
    "NE",
    "E",
    "SE",
    "S",
    "SW",
    "W",
    "NW",
  ];
  const index = Math.round(bearingDegrees / 45) % directions.length;
  return directions[index];
}

function degreesToRadians(value: number): number {
  return value * (Math.PI / 180);
}

function radiansToDegrees(value: number): number {
  return value * (180 / Math.PI);
}
