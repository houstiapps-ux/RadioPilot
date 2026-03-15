// Centralized scoring knobs for the opportunity engine.
// Tune these in small steps and re-run snapshot replay + regression tests after each change.
// Avoid changing weights and quality thresholds in the same pass unless a regression requires it.

export const OPPORTUNITY_SCORING = {
  bandBase: {
    totalSpotWeight: 100,
    uniqueCallWeight: 10,
    portableSpotWeight: 25,
  },
  aggregate: {
    offContinentSpotWeight: 40,
    directionalUniqueCallWeight: 20,
    directionSpreadWeight: 15,
    activeModeFamilyWeight: 12,
  },
  propagationBoost: {
    highConfidence: 24,
    mediumConfidence: 12,
    sectorBonus: 10,
  },
  pskBoost: {
    activeBandBonus: 18,
    risingWindowBonus: 12,
    risingTrendBonus: 10,
    fallingTrendPenalty: -14,
    modeAgreementBonus: 8,
  },
  operatingStyleDx: {
    offContinentSpotWeight: 60,
    distanceKmDivisor: 250,
  },
  intentBoost: {
    dxOffContinentSpotWeight: 30,
    dxDistanceKmDivisor: 350,
    potaTagWeight: 160,
    potaPortablePenalty: 10,
    sotaTagWeight: 180,
    portableSpotWeight: 90,
    digitalSpotWeight: 45,
  },
  dxIntentBoost: {
    chasingDx: 0.24,
    chasingDigital: 0.12,
    portablePenalty: -0.12,
  },
  watchThresholds: {
    minPredictedScoreWithNoPsk: 0.75,
    minSupportPredictedScore: 0.65,
  },
  dxMeaningfulThresholds: {
    rarityStrong: 0.7,
    minLowConfidencePath: 0.2,
    fallbackHighPath: 0.8,
    fallbackActivity: 0.25,
    standardActivity: 0.45,
    standardPath: 0.2,
  },
  rejectionThresholds: {
    lowScoreRatio: 0.5,
    dxLowScore: 0.5,
  },
} as const;

export const NEARBY_SCORING = {
  weights: {
    distance: 0.35,
    activity: 0.25,
    portable: 0.2,
    bandSuitability: 0.1,
    freshness: 0.1,
  },
  thresholds: {
    highActivity: 0.72,
    moderateActivity: 0.45,
    localHighConfidence: 0.65,
    extendedHighConfidence: 0.55,
  },
} as const;

export const DX_EVENT_SCORING = {
  eventTypeStrength: {
    possibleDxpedition: 0.88,
    rareDxActive: 0.82,
    multiBandDxActivity: 0.72,
    highSpotterInterest: 0.66,
    fallback: 0.5,
  },
} as const;
