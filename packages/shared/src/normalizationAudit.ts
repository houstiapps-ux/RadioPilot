import { deriveBandFromFrequencyKhz, isValidBand, resolveBand } from "./bands.js";
import type { ParsedSpot } from "./types.js";

export interface SpotNormalizationAudit {
  readonly derivedBandCount: number;
  readonly unknownBandCount: number;
  readonly portableDetectedCount: number;
  readonly unresolvedEntityCount: number;
  readonly missingFreshnessTimestampCount: number;
}

export function summarizeSpotNormalization(
  spots: readonly ParsedSpot[],
): SpotNormalizationAudit {
  let derivedBandCount = 0;
  let unknownBandCount = 0;
  let portableDetectedCount = 0;
  let unresolvedEntityCount = 0;
  let missingFreshnessTimestampCount = 0;

  for (const spot of spots) {
    const derivedBand = deriveBandFromFrequencyKhz(spot.frequencyKHz);
    const resolvedBand = resolveBand(spot.band, spot.frequencyKHz);

    if (!isValidBand(spot.band) && derivedBand !== null) {
      derivedBandCount += 1;
    }

    if (resolvedBand === null) {
      unknownBandCount += 1;
    }

    if (isPortableSpot(spot)) {
      portableDetectedCount += 1;
    }

    if (!spot.countryCode && !spot.continentDx) {
      unresolvedEntityCount += 1;
    }

    if (!spot.observedAt) {
      missingFreshnessTimestampCount += 1;
    }
  }

  return {
    derivedBandCount,
    unknownBandCount,
    portableDetectedCount,
    unresolvedEntityCount,
    missingFreshnessTimestampCount,
  };
}

function isPortableSpot(spot: ParsedSpot): boolean {
  const callsign = spot.spottedCallsign.toUpperCase();
  const comment = spot.comment.toUpperCase();

  return (
    callsign.includes("/P") ||
    callsign.includes("/M") ||
    spot.tags.includes("SOTA") ||
    spot.tags.includes("POTA") ||
    spot.tags.includes("WWFF") ||
    spot.tags.includes("/P") ||
    comment.includes("SOTA") ||
    comment.includes("POTA") ||
    comment.includes("/P") ||
    comment.includes("/M")
  );
}
