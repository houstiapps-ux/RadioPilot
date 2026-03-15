import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildOpportunitySnapshotWithDebug,
  type OpportunityDebugSnapshot,
} from "./opportunities.js";
import type {
  BandPredictionMap,
  PropagationDensityMap,
  PskBandTrendMap,
  PskReporterSummary,
  SolarConditions,
} from "./types.js";
import type { DxRarityContext } from "./dxRarity.js";
import type { DxEventCandidate } from "./dxEvents.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");
const fixturesRoot = path.resolve(repoRoot, "fixtures/opportunity-snapshots");

type ChasingFilter = "dx" | "pota" | "sota" | "portable" | "digital";
type ModeFilter = "ssb" | "cw" | "digital";
type BandScope = "hf" | "vhf-uhf";

interface RegressionFixture {
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
      readonly bandPredictions: BandPredictionMap;
      readonly propagationDensity: PropagationDensityMap;
    };
    readonly dx: {
      readonly events: readonly DxEventCandidate[];
      readonly rarity?: DxRarityContext;
    };
    readonly spots: Parameters<typeof buildOpportunitySnapshotWithDebug>[0];
  };
}

test("fixture: strong 20m current activity stays best and keeps confidence/evidence aligned", async () => {
  const debug = await replayFixture("regression-strong-20m-current.json");

  assert.equal(debug.snapshot.bestOpportunity?.band, "20m");
  assert.equal(debug.snapshot.bestOpportunity?.confidence, "High");
  assert.equal(debug.snapshot.bestOpportunity?.evidenceFlags?.psk, true);
  assert.equal(
    /limited PSK support/i.test(debug.snapshot.bestOpportunity?.confidenceReason ?? ""),
    false,
  );
});

test("fixture: high-band opening drives Watch Next toward the opening band", async () => {
  const debug = await replayFixture("regression-high-band-opening.json");

  assert.equal(debug.snapshot.bestOpportunity?.band, "20m");
  assert.equal(debug.snapshot.watchNext[0]?.band, "15m");
  assert.equal(debug.snapshot.watchNext[0]?.bandState, "Opening");
  assert.equal(debug.snapshot.watchNext[0]?.trendLabel, "Rising");
});

test("fixture: rare DX stays distinct from Best Opportunity", async () => {
  const debug = await replayFixture("regression-rare-dx-active.json");

  assert.equal(debug.snapshot.bestOpportunity?.callsign, "K1AAA");
  assert.equal(debug.snapshot.dxOpportunity?.callsign, "FT4GL");
  assert.notEqual(debug.snapshot.dxOpportunity?.callsign, debug.snapshot.bestOpportunity?.callsign);
  assert.equal(debug.snapshot.dxOpportunity?.dxEventType, "Possible DXpedition");
  assert.ok((debug.dxCandidates[0]?.scoreBreakdown.rarityScore ?? 0) >= 0.8);
});

test("fixture: nearby portable remains local/regional and portable-tagged", async () => {
  const debug = await replayFixture("regression-nearby-portable.json");

  assert.equal(debug.snapshot.nearbyActivity[0]?.callsign, "EI7ABC/P");
  assert.equal(debug.snapshot.nearbyActivity[0]?.portableType, "SOTA");
  assert.equal(debug.snapshot.nearbyActivity[0]?.cardType, "nearby");
  assert.ok((debug.snapshot.nearbyActivity[0]?.distanceKm ?? Infinity) <= 2500);
});

test("fixture: strict filters remove non-matching opportunities", async () => {
  const debug = await replayFixture("regression-no-opportunity-strict-filter.json");

  assert.equal(debug.snapshot.bestOpportunity, null);
  assert.equal(debug.snapshot.watchNext.length, 0);
  assert.equal(debug.snapshot.dxOpportunity, null);
  assert.equal(debug.snapshot.nearbyActivity.length, 0);
});

async function replayFixture(name: string): Promise<OpportunityDebugSnapshot> {
  const fixturePath = path.resolve(fixturesRoot, name);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as RegressionFixture;

  return buildOpportunitySnapshotWithDebug(fixture.input.spots, {
    now: Date.parse(fixture.capturedAt),
    homeGrid: fixture.userProfile.homeGrid,
    operatingStyle: fixture.userProfile.operatingStyle,
    chasing: fixture.filters.chasing,
    modeFilter: fixture.filters.mode,
    bandScope: fixture.filters.bandScope,
    solar: fixture.input.solar,
    pskSummary: fixture.input.psk.summary,
    pskTrends: fixture.input.psk.trends,
    dxRarity: fixture.input.dx.rarity,
    dxEvents: fixture.input.dx.events,
    bandPredictions: fixture.input.psk.bandPredictions,
    propagationDensity: fixture.input.psk.propagationDensity,
  });
}
