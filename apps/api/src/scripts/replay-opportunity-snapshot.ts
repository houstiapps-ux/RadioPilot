import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildOpportunitySnapshotFromInputs,
  type OpportunityCard,
  type OpportunityEngineInputs,
  type OpportunitySnapshot,
  type PskBandTrendMap,
  type PskReporterSummary,
  type SolarConditions,
} from "@radio-pilot/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");

type ChasingFilter = "dx" | "pota" | "sota" | "portable" | "digital";
type ModeFilter = "ssb" | "cw" | "digital";
type BandScope = "hf" | "vhf-uhf";

interface ReplayCliOptions {
  readonly fixturePath: string;
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
      readonly bandPredictions: OpportunityEngineInputs["bandPredictions"];
      readonly propagationDensity: OpportunityEngineInputs["propagationDensity"];
    };
    readonly dx: {
      readonly bandResolution: {
        readonly sourceBandMissing: number;
        readonly frequencyDerivedBandUsed: number;
        readonly unresolvedBand: number;
      };
      readonly rarityGeneratedAt?: string;
      readonly events: OpportunityEngineInputs["dxEvents"];
    };
    readonly spots: OpportunityEngineInputs["spots"];
  };
  readonly output?: {
    readonly snapshot: OpportunitySnapshot;
    readonly debug: ReturnType<typeof buildOpportunitySnapshotFromInputs>;
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixture = await loadFixture(options.fixturePath);
  const debug = buildOpportunitySnapshotFromInputs({
    now: Date.parse(fixture.capturedAt),
    rawSpots: [],
    spots: fixture.input.spots,
    solar: fixture.input.solar,
    pskSummary: fixture.input.psk.summary,
    pskTrends: fixture.input.psk.trends,
    bandPredictions: fixture.input.psk.bandPredictions ?? {},
    propagationDensity: fixture.input.psk.propagationDensity ?? {},
    dxRarity: null,
    dxEvents: fixture.input.dx.events ?? [],
    bandResolution: fixture.input.dx.bandResolution,
  }, {
    homeGrid: fixture.userProfile.homeGrid,
    operatingStyle: fixture.userProfile.operatingStyle,
    chasing: fixture.filters.chasing,
    modeFilter: fixture.filters.mode,
    bandScope: fixture.filters.bandScope,
  });

  const summary = {
    best: formatCardSummary(debug.snapshot.bestOpportunity),
    watch: debug.snapshot.watchNext.slice(0, 3).map(formatCardSummary),
    dx: formatCardSummary(debug.snapshot.dxOpportunity),
    nearby: debug.snapshot.nearbyActivity.slice(0, 3).map(formatCardSummary),
  };

  process.stdout.write(`Best: ${summary.best}\n`);
  process.stdout.write(`Watch: ${summary.watch.join(" | ") || "None"}\n`);
  process.stdout.write(`DX: ${summary.dx}\n`);
  process.stdout.write(`Nearby: ${summary.nearby.join(" | ") || "None"}\n\n`);

  const output = {
    fixture: path.relative(repoRoot, options.fixturePath),
    capturedAt: fixture.capturedAt,
    filters: fixture.filters,
    summary,
    result: {
      snapshot: debug.snapshot,
      candidates: debug.candidates,
      dxCandidates: debug.dxCandidates,
      nearbyCandidates: debug.nearbyCandidates,
    },
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function parseArgs(args: readonly string[]): ReplayCliOptions {
  const fixtureArg = args.find((arg) => !arg.startsWith("--"));

  if (!fixtureArg) {
    throw new Error("Fixture path required. Usage: pnpm replay:snapshot fixtures/opportunity-snapshots/example.json");
  }

  return {
    fixturePath: path.resolve(repoRoot, fixtureArg),
  };
}

async function loadFixture(fixturePath: string): Promise<OpportunitySnapshotFixture> {
  const raw = await readFile(fixturePath, "utf8");
  const fixture = JSON.parse(raw) as OpportunitySnapshotFixture;

  if (
    typeof fixture !== "object" ||
    fixture === null ||
    fixture.version !== 1 ||
    typeof fixture.capturedAt !== "string" ||
    !fixture.input ||
    !Array.isArray(fixture.input.spots)
  ) {
    throw new Error(`Invalid fixture: ${fixturePath}`);
  }

  return fixture;
}

function formatCardSummary(card: OpportunityCard | null): string {
  if (!card) {
    return "None";
  }

  const parts = [
    card.band ?? "Unknown",
    card.modeSummary ?? "",
    card.callsign,
    card.direction ? card.direction : "",
    card.confidence ?? "",
    card.dxEventType ?? "",
  ].filter((value) => value.length > 0);

  return parts.join(" ");
}

await main();
