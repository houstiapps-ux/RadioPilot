import type { ParsedSpot } from "./types.js";

const BASELINE_BUCKET_MS = 60 * 60 * 1000;
const BASELINE_LOOKBACK_BUCKETS = 24;
const BASELINE_KEY_TTL_SECONDS = 60 * 60 * 48;
const COMMON_APPEARANCE_COUNT = 48;

export interface DxBaselineRedisClient {
  hGet(key: string, field: string): Promise<string | null>;
  hmGet(key: string, fields: string[]): Promise<Array<string | null>>;
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface DxRarityContext {
  readonly callsigns: Readonly<Record<string, number>>;
  readonly entities: Readonly<Record<string, number>>;
  readonly generatedAt: number;
}

export interface DxCandidateRarityInput {
  readonly callsign: string;
  readonly entity?: string;
  readonly activityScore: number;
  readonly pathScore: number;
  readonly solarScore: number;
}

export interface DxCandidateRarityScore {
  readonly activityScore: number;
  readonly rarityScore: number;
  readonly pathScore: number;
  readonly solarScore: number;
  readonly dxScore: number;
}

export async function updateDxBaseline(
  spots: readonly ParsedSpot[],
  redis: DxBaselineRedisClient,
  now = Date.now(),
): Promise<void> {
  if (spots.length === 0) {
    return;
  }

  const bucket = getBucketId(now);
  const callKey = getCallBaselineKey(bucket);
  const entityKey = getEntityBaselineKey(bucket);
  const writes: Promise<unknown>[] = [];

  for (const spot of spots) {
    const callsign = normalizeCallsign(spot.spottedCallsign);

    if (callsign) {
      writes.push(redis.hIncrBy(callKey, callsign, 1));
    }

    const entity = getSpotEntityKey(spot);

    if (entity) {
      writes.push(redis.hIncrBy(entityKey, entity, 1));
    }
  }

  writes.push(redis.expire(callKey, BASELINE_KEY_TTL_SECONDS));
  writes.push(redis.expire(entityKey, BASELINE_KEY_TTL_SECONDS));
  await Promise.all(writes);
}

export async function loadDxRarityContext(
  redis: DxBaselineRedisClient,
  spots: readonly ParsedSpot[],
  now = Date.now(),
): Promise<DxRarityContext> {
  const callsigns = [...new Set(spots.map((spot) => normalizeCallsign(spot.spottedCallsign)).filter(isNonEmpty))];
  const entities = [...new Set(spots.map((spot) => getSpotEntityKey(spot)).filter(isNonEmpty))];
  const buckets = getRecentBuckets(now);

  return {
    callsigns: await loadCounterMap(redis, buckets.map(getCallBaselineKey), callsigns),
    entities: await loadCounterMap(redis, buckets.map(getEntityBaselineKey), entities),
    generatedAt: now,
  };
}

export async function computeCallsignRarity(
  callsign: string,
  redis: DxBaselineRedisClient,
  now = Date.now(),
): Promise<number> {
  const normalized = normalizeCallsign(callsign);

  if (!normalized) {
    return 0.5;
  }

  const buckets = getRecentBuckets(now);
  const count = await readCountAcrossKeys(
    redis,
    buckets.map(getCallBaselineKey),
    normalized,
  );

  return convertCountToRarity(count);
}

export async function computeEntityRarity(
  entity: string,
  redis: DxBaselineRedisClient,
  now = Date.now(),
): Promise<number> {
  const normalized = normalizeEntity(entity);

  if (!normalized) {
    return 0.5;
  }

  const buckets = getRecentBuckets(now);
  const count = await readCountAcrossKeys(
    redis,
    buckets.map(getEntityBaselineKey),
    normalized,
  );

  return convertCountToRarity(count);
}

export function scoreDxCandidate(
  candidate: DxCandidateRarityInput,
  context: DxRarityContext | null | undefined,
): DxCandidateRarityScore {
  const rarityScore = getCombinedRarity(candidate.callsign, candidate.entity, context);
  const dxScore =
    0.35 * clamp01(candidate.activityScore) +
    0.35 * rarityScore +
    0.20 * clamp01(candidate.pathScore) +
    0.10 * clamp01(candidate.solarScore);

  return {
    activityScore: clamp01(candidate.activityScore),
    rarityScore,
    pathScore: clamp01(candidate.pathScore),
    solarScore: clamp01(candidate.solarScore),
    dxScore,
  };
}

export function getCombinedRarity(
  callsign: string,
  entity: string | undefined,
  context: DxRarityContext | null | undefined,
): number {
  if (!context) {
    return 0.5;
  }

  const normalizedCallsign = normalizeCallsign(callsign);
  const normalizedEntity = normalizeEntity(entity);
  const callsignCount = normalizedCallsign ? context.callsigns[normalizedCallsign] ?? 0 : 0;
  const entityCount = normalizedEntity ? context.entities[normalizedEntity] ?? 0 : 0;
  const callsignRarity = convertCountToRarity(callsignCount);
  const entityRarity = normalizedEntity ? convertCountToRarity(entityCount) : callsignRarity;

  return clamp01(entityRarity * 0.6 + callsignRarity * 0.4);
}

export function getSpotEntityKey(spot: Pick<ParsedSpot, "countryCode" | "continentDx">): string | undefined {
  return normalizeEntity(spot.countryCode ?? spot.continentDx);
}

function getRecentBuckets(now: number): readonly number[] {
  const currentBucket = getBucketId(now);
  return Array.from({ length: BASELINE_LOOKBACK_BUCKETS }, (_, index) => currentBucket - index);
}

function getBucketId(timestampMs: number): number {
  return Math.floor(timestampMs / BASELINE_BUCKET_MS);
}

function getCallBaselineKey(bucket: number): string {
  return `dx:baseline:calls:${bucket}`;
}

function getEntityBaselineKey(bucket: number): string {
  return `dx:baseline:entity:${bucket}`;
}

async function loadCounterMap(
  redis: DxBaselineRedisClient,
  keys: readonly string[],
  fields: readonly string[],
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  if (fields.length === 0) {
    return result;
  }

  for (const field of fields) {
    result[field] = 0;
  }

  // One HMGET per bucket, rather than one HGET per bucket per field. With 24
  // buckets and a few hundred callsigns that is the difference between 24 and
  // several thousand round-trips on every refresh.
  const bucketValues = await Promise.all(keys.map((key) => redis.hmGet(key, [...fields])));

  for (const values of bucketValues) {
    for (let index = 0; index < fields.length; index += 1) {
      const parsed = Number.parseInt(values[index] ?? "0", 10);

      if (Number.isFinite(parsed)) {
        result[fields[index]] += parsed;
      }
    }
  }

  return result;
}

async function readCountAcrossKeys(
  redis: DxBaselineRedisClient,
  keys: readonly string[],
  field: string,
): Promise<number> {
  const values = await Promise.all(keys.map((key) => redis.hGet(key, field)));

  return values.reduce((total, value) => {
    const parsed = Number.parseInt(value ?? "0", 10);
    return Number.isFinite(parsed) ? total + parsed : total;
  }, 0);
}

function convertCountToRarity(count: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 1;
  }

  const rarity = 1 - Math.log1p(count) / Math.log1p(COMMON_APPEARANCE_COUNT);
  return clamp(rarity, 0.1, 1);
}

function normalizeCallsign(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeEntity(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
