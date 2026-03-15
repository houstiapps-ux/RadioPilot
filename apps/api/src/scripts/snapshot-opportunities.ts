import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "redis";

import {
  buildOpportunitySnapshotWithDebug,
  detectDxEvents,
  getAllBandTrends,
  getDirectionalPropagation,
  loadDxRarityContext,
  parseMaidenheadLocator,
  parseStoredOpportunitySpot,
  predictBandOpenings,
  summarizeStoredSpotBandResolution,
  type OpportunitySnapshot,
  type PskBandTrendMap,
  type PskReporterSummary,
  type SolarConditions,
} from "@radio-pilot/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");

dotenv.config({ path: path.resolve(repoRoot, ".env"), quiet: true });

const RECENT_WINDOW_MS = 15 * 60 * 1000;
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

type ChasingFilter = "dx" | "pota" | "sota" | "portable" | "digital";
type ModeFilter = "ssb" | "cw" | "digital";
type BandScope = "hf" | "vhf-uhf";

interface SnapshotCliOptions {
  readonly homeGrid?: string;
  readonly operatingStyle?: "dx";
  readonly chasing?: ChasingFilter;
  readonly modeFilter?: ModeFilter;
  readonly bandScope?: BandScope;
  readonly outputName?: string;
}

interface OpportunitySnapshotFixture {
  readonly version: 1;
  readonly capturedAt: string;
  readonly userProfile: {
    readonly homeGrid?: string;
    readonly operatingStyle?: "dx";
  };
  readonly filters: {
    readonly chasing?: ChasingFilter;
    readonly mode?: ModeFilter;
    readonly bandScope?: BandScope;
  };
  readonly input: {
    readonly solar: SolarConditions | null;
    readonly psk: {
      readonly summary: PskReporterSummary | null;
      readonly trends: PskBandTrendMap;
      readonly bandPredictions: Awaited<ReturnType<typeof predictBandOpenings>>;
      readonly propagationDensity: Awaited<ReturnType<typeof getDirectionalPropagation>>;
    };
    readonly dx: {
      readonly bandResolution: ReturnType<typeof summarizeStoredSpotBandResolution>;
      readonly rarityGeneratedAt?: string;
      readonly events: Awaited<ReturnType<typeof detectDxEvents>>;
    };
    readonly spots: ReturnType<typeof parseStoredOpportunitySpot>[number][];
  };
  readonly output: {
    readonly snapshot: OpportunitySnapshot;
    readonly debug: ReturnType<typeof buildOpportunitySnapshotWithDebug>;
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const redis = createClient({ url: redisUrl });
  await redis.connect();

  try {
    const [rawSpots, rawSolar, rawPsk, pskTrends, bandPredictions, propagationDensity] = await Promise.all([
      redis.zRangeByScore("spots:recent", now - RECENT_WINDOW_MS * 2, now),
      redis.get("solar:latest"),
      redis.get("psk:summary"),
      getAllBandTrends(redis),
      predictBandOpenings(redis, {}),
      getDirectionalPropagation(redis, {}),
    ]);

    const spots = rawSpots.flatMap(parseStoredOpportunitySpot);
    const dxRarity = await loadDxRarityContext(redis, spots, now);
    const dxEvents = await detectDxEvents(spots, redis, now, { rarity: dxRarity });
    const solar = parseSolar(rawSolar);
    const pskSummary = parsePskSummary(rawPsk);
    const debug = buildOpportunitySnapshotWithDebug(spots, {
      now,
      homeGrid: options.homeGrid,
      operatingStyle: options.operatingStyle,
      chasing: options.chasing,
      modeFilter: options.modeFilter,
      bandScope: options.bandScope,
      solar,
      pskSummary,
      pskTrends,
      dxRarity,
      dxEvents,
      bandPredictions,
      propagationDensity,
    });

    const fixture: OpportunitySnapshotFixture = {
      version: 1,
      capturedAt: new Date(now).toISOString(),
      userProfile: {
        homeGrid: options.homeGrid,
        operatingStyle: options.operatingStyle,
      },
      filters: {
        chasing: options.chasing,
        mode: options.modeFilter,
        bandScope: options.bandScope,
      },
      input: {
        solar,
        psk: {
          summary: pskSummary,
          trends: pskTrends,
          bandPredictions,
          propagationDensity,
        },
        dx: {
          bandResolution: summarizeStoredSpotBandResolution(rawSpots),
          rarityGeneratedAt: new Date(dxRarity.generatedAt).toISOString(),
          events: dxEvents,
        },
        spots,
      },
      output: {
        snapshot: debug.snapshot,
        debug,
      },
    };

    const fixtureDirectory = path.resolve(repoRoot, "fixtures/opportunity-snapshots");
    await mkdir(fixtureDirectory, { recursive: true });
    const outputName = buildOutputName(now, options.outputName);
    const fixturePath = path.resolve(fixtureDirectory, outputName);
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    process.stdout.write(`${fixturePath}\n`);
  } finally {
    await redis.quit();
  }
}

function parseArgs(args: readonly string[]): SnapshotCliOptions {
  const values = new Map<string, string>();

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, rawValue] = arg.slice(2).split("=", 2);

    if (rawKey && rawValue) {
      values.set(rawKey, rawValue);
    }
  }

  const homeGrid = normalizeHomeGrid(values.get("homeGrid"));
  const operatingStyle = normalizeOperatingStyle(values.get("operatingStyle"));
  const chasing = normalizeChasing(values.get("chasing"));
  const modeFilter = normalizeMode(values.get("mode"));
  const bandScope = normalizeBandScope(values.get("bandScope"));
  const outputName = normalizeOutputName(values.get("name"));

  return {
    homeGrid,
    operatingStyle,
    chasing,
    modeFilter,
    bandScope,
    outputName,
  };
}

function normalizeHomeGrid(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return parseMaidenheadLocator(normalized) ? normalized : undefined;
}

function normalizeOperatingStyle(value: string | undefined): "dx" | undefined {
  return value?.trim().toLowerCase() === "dx" ? "dx" : undefined;
}

function normalizeChasing(value: string | undefined): ChasingFilter | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "dx" ||
    normalized === "pota" ||
    normalized === "sota" ||
    normalized === "portable" ||
    normalized === "digital"
    ? normalized
    : undefined;
}

function normalizeMode(value: string | undefined): ModeFilter | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "ssb" || normalized === "cw" || normalized === "digital"
    ? normalized
    : undefined;
}

function normalizeBandScope(value: string | undefined): BandScope | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "hf" || normalized === "vhf-uhf" ? normalized : undefined;
}

function normalizeOutputName(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return value.trim().replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
}

function buildOutputName(now: number, name: string | undefined): string {
  const timestamp = new Date(now).toISOString().replaceAll(":", "-");
  return name ? `${timestamp}-${name}.json` : `${timestamp}.json`;
}

function parseSolar(value: string | null): SolarConditions | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SolarConditions>;
    return typeof parsed.updatedAt === "string"
      ? {
        sfi: typeof parsed.sfi === "number" ? parsed.sfi : undefined,
        kp: typeof parsed.kp === "number" ? parsed.kp : undefined,
        aIndex: typeof parsed.aIndex === "number" ? parsed.aIndex : undefined,
        muf:
          typeof parsed.muf === "number" || typeof parsed.muf === "string"
            ? parsed.muf
            : undefined,
        sunspots: typeof parsed.sunspots === "number" ? parsed.sunspots : undefined,
        updatedAt: parsed.updatedAt,
        favouredBands: Array.isArray(parsed.favouredBands) ? parsed.favouredBands : undefined,
        solarSummary: Array.isArray(parsed.solarSummary) ? parsed.solarSummary : undefined,
      }
      : null;
  } catch {
    return null;
  }
}

function parsePskSummary(value: string | null): PskReporterSummary | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as PskReporterSummary;
    return Array.isArray(parsed.bands) ? parsed : null;
  } catch {
    return null;
  }
}

await main();
