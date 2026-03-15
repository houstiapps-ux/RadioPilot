export interface PathStabilityContext {
  readonly pskCurrent: number;
  readonly pskPrevious: number;
  readonly directionConfidence?: "High" | "Medium" | "Low" | null;
  readonly directionSpread?: number | null;
  readonly currentCallsignSpots: number;
  readonly totalSpots: number;
  readonly freshnessSeconds?: number | null;
}

export interface PathStabilityResult {
  readonly pathStability: "Strong" | "Moderate" | "Weak";
  readonly pathStabilityScore: number;
  readonly pskContinuity: number;
  readonly spotPersistence: number;
  readonly directionConsistency: number;
}

export function calculatePathStability(
  context: PathStabilityContext,
): PathStabilityResult | null {
  if (context.totalSpots <= 0) {
    return null;
  }

  const pskContinuity = scorePskContinuity(context.pskCurrent, context.pskPrevious);
  const spotPersistence = scoreSpotPersistence(
    context.currentCallsignSpots,
    context.totalSpots,
    context.freshnessSeconds ?? null,
  );
  const directionConsistency = scoreDirectionConsistency(
    context.directionConfidence ?? null,
    context.directionSpread ?? null,
  );
  const stabilityScore = clamp01(
    0.5 * pskContinuity +
    0.3 * spotPersistence +
    0.2 * directionConsistency,
  );

  return {
    pathStability: toPathStabilityLabel(stabilityScore),
    pathStabilityScore: round2(stabilityScore),
    pskContinuity: round2(pskContinuity),
    spotPersistence: round2(spotPersistence),
    directionConsistency: round2(directionConsistency),
  };
}

function scorePskContinuity(current: number, previous: number): number {
  if (current <= 0 && previous <= 0) {
    return 0.2;
  }

  if (current <= 0 || previous <= 0) {
    return 0.35;
  }

  const balance = Math.min(current, previous) / Math.max(current, previous);
  const sustainedVolume = clamp01(Math.min(current, previous) / 20);
  return clamp01(0.35 + balance * 0.4 + sustainedVolume * 0.25);
}

function scoreSpotPersistence(
  callsignSpots: number,
  totalSpots: number,
  freshnessSeconds: number | null,
): number {
  const repeatScore = clamp01((callsignSpots - 1) / 3);
  const shareScore = clamp01((callsignSpots / Math.max(totalSpots, 1)) * 2);
  const freshnessScore =
    freshnessSeconds === null ? 0.5
      : freshnessSeconds <= 60 ? 1
        : freshnessSeconds <= 180 ? 0.8
          : freshnessSeconds <= 600 ? 0.6
            : 0.35;

  return clamp01(0.4 * Math.max(repeatScore, shareScore) + 0.6 * freshnessScore);
}

function scoreDirectionConsistency(
  confidence: "High" | "Medium" | "Low" | null,
  spread: number | null,
): number {
  const confidenceScore =
    confidence === "High" ? 0.9
      : confidence === "Medium" ? 0.65
        : 0.35;
  const spreadScore = spread === null ? 0.35 : clamp01(spread / 4);
  return clamp01(0.65 * confidenceScore + 0.35 * spreadScore);
}

function toPathStabilityLabel(score: number): "Strong" | "Moderate" | "Weak" {
  if (score > 0.7) {
    return "Strong";
  }

  if (score >= 0.4) {
    return "Moderate";
  }

  return "Weak";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
