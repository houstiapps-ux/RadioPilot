import { maidenheadToLatLon, parseMaidenheadLocator, type MaidenheadCoordinates } from "./maidenhead.js";

export function gridToLatLon(grid: string): MaidenheadCoordinates | null {
  return parseMaidenheadLocator(grid) ? maidenheadToLatLon(grid) : null;
}

export function distanceKm(gridA: string, gridB: string): number | null {
  const from = gridToLatLon(gridA);
  const to = gridToLatLon(gridB);

  if (!from || !to) {
    return null;
  }

  return haversineDistanceKm(from, to);
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

function degreesToRadians(value: number): number {
  return value * (Math.PI / 180);
}
