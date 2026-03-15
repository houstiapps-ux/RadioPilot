import assert from "node:assert/strict";
import test from "node:test";

import {
  computeCallsignRarity,
  computeEntityRarity,
  loadDxRarityContext,
  scoreDxCandidate,
  updateDxBaseline,
} from "./dxRarity.js";
import type { ParsedSpot } from "./types.js";

test("updates and reads rolling DX rarity baseline", async () => {
  const redis = createMockRedis();
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const rareSpot = createSpot("FT4GL", "FR");
  const commonSpot = createSpot("K1ABC", "US");

  await updateDxBaseline([rareSpot], redis, now);
  await updateDxBaseline(Array.from({ length: 12 }, () => commonSpot), redis, now);

  const rareRarity = await computeCallsignRarity("FT4GL", redis, now);
  const commonRarity = await computeCallsignRarity("K1ABC", redis, now);

  assert.ok(rareRarity > commonRarity);

  const context = await loadDxRarityContext(redis, [rareSpot, commonSpot], now);
  const rareScore = scoreDxCandidate({
    callsign: "FT4GL",
    entity: "FR",
    activityScore: 0.7,
    pathScore: 0.6,
    solarScore: 0.5,
  }, context);
  const commonScore = scoreDxCandidate({
    callsign: "K1ABC",
    entity: "US",
    activityScore: 0.7,
    pathScore: 0.6,
    solarScore: 0.5,
  }, context);

  assert.ok(rareScore.rarityScore > commonScore.rarityScore);
  assert.ok(rareScore.dxScore > commonScore.dxScore);

  const entityRarity = await computeEntityRarity("US", redis, now);
  assert.ok(entityRarity < 0.6);
});

function createSpot(callsign: string, countryCode: string): ParsedSpot {
  return {
    id: callsign,
    source: "dxheat",
    spotterCallsign: "EI2TEST",
    spottedCallsign: callsign,
    countryCode,
    continentDx: countryCode === "US" ? "NA" : "AF",
    frequencyKHz: 14074,
    band: "20m",
    observedAt: "2026-03-15T11:58:00.000Z",
    mode: "ft8",
    modeFamily: "digital",
    comment: "CQ",
    tags: ["FT8"],
  };
}

function createMockRedis() {
  const hashes = new Map<string, Map<string, number>>();

  return {
    async hGet(key: string, field: string): Promise<string | null> {
      const value = hashes.get(key)?.get(field);
      return typeof value === "number" ? String(value) : null;
    },
    async hIncrBy(key: string, field: string, increment: number): Promise<number> {
      const hash = hashes.get(key) ?? new Map<string, number>();
      const next = (hash.get(field) ?? 0) + increment;
      hash.set(field, next);
      hashes.set(key, hash);
      return next;
    },
    async expire(): Promise<number> {
      return 1;
    },
  };
}
