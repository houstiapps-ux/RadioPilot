import assert from "node:assert/strict";
import test from "node:test";

import {
  generateOpportunities,
  type OpportunityRedisClient,
} from "./opportunityEngine.js";

test("generates four operator cards from Redis-backed signals", async () => {
  const now = Date.now();
  const redis = createFakeRedis(now);

  const result = await generateOpportunities({
    homeGrid: "IO63UI",
    homeContinent: "EU",
    operatingStyle: "DX",
    modePreference: ["FT8", "CW"],
    bandsAvailable: ["20m", "17m", "15m"],
    antennaType: "beam",
  }, redis);

  assert.ok(result.bestOpportunity);
  assert.equal(result.bestOpportunity?.band, "20m");
  assert.ok(result.bestOpportunity?.reason.length);
  assert.equal(result.bestOpportunity?.directionConfidence, "High");
  assert.ok(result.bestOpportunity?.signals?.some((signal) => signal.includes("propagation")));
  assert.ok(result.watchNext);
  assert.ok(result.watchNext?.bandState);
  assert.ok(result.watchNext?.signals?.length);
  assert.ok(result.dxOpportunity);
  assert.notEqual(result.dxOpportunity?.callsign, result.bestOpportunity?.callsign);
  assert.ok(result.dxOpportunity?.actionLine);
  assert.ok(result.nearbyActivity);
});

function createFakeRedis(now: number): OpportunityRedisClient {
  const observedAt = new Date(now - 60_000).toISOString();
  const previousObservedAt = new Date(now - 20 * 60_000).toISOString();
  const rawSpots = [
    JSON.stringify({
      id: "spot-1",
      source: "dxheat",
      spotterCallsign: "EI2TEST",
      spottedCallsign: "K1ABC",
      continentDx: "NA",
      countryCode: "US",
      dxLocator: "FN31PR",
      frequencyKHz: 14074,
      band: "20m",
      observedAt,
      mode: "ft8",
      modeFamily: "digital",
      comment: "CQ DX",
      tags: ["FT8"],
      receivedAt: observedAt,
    }),
    JSON.stringify({
      id: "spot-2",
      source: "dxheat",
      spotterCallsign: "EI2TEST",
      spottedCallsign: "EA8ABC",
      continentDx: "AF",
      countryCode: "ES",
      dxLocator: "IL18",
      frequencyKHz: 18100,
      band: "17m",
      observedAt,
      mode: "ft8",
      modeFamily: "digital",
      comment: "CQ",
      tags: ["FT8"],
      receivedAt: observedAt,
    }),
    JSON.stringify({
      id: "spot-3",
      source: "dxheat",
      spotterCallsign: "EI2TEST",
      spottedCallsign: "EI/P123",
      continentDx: "EU",
      countryCode: "IE",
      dxLocator: "IO63UI",
      frequencyKHz: 7100,
      band: "40m",
      observedAt,
      mode: "ssb",
      modeFamily: "phone",
      comment: "Portable",
      tags: ["POTA", "/P"],
      receivedAt: observedAt,
    }),
    JSON.stringify({
      id: "spot-4",
      source: "dxheat",
      spotterCallsign: "EI2TEST",
      spottedCallsign: "JA1OLD",
      continentDx: "AS",
      countryCode: "JP",
      dxLocator: "PM95TU",
      frequencyKHz: 14074,
      band: "20m",
      observedAt: previousObservedAt,
      mode: "ft8",
      modeFamily: "digital",
      comment: "Earlier path",
      tags: ["FT8"],
      receivedAt: previousObservedAt,
    }),
  ];

  const values = new Map<string, string | null>([
    ["psk:summary", JSON.stringify({
      generatedAt: new Date(now).toISOString(),
      freshnessTimestamp: new Date(now).toISOString(),
      currentWindowStart: new Date(now - 15 * 60_000).toISOString(),
      previousWindowStart: new Date(now - 30 * 60_000).toISOString(),
      windowMinutes: 15,
      bands: [
        {
          band: "20m",
          currentWindowCount: 90,
          previousWindowCount: 40,
          trend: 50,
          modeCounts: { FT8: 75 },
          directionCounts: { W: 18 },
          pathCounts: { "NA->EU": 18 },
          uniqueSenderLocatorCount: 14,
          uniqueReceiverLocatorCount: 10,
        },
        {
          band: "17m",
          currentWindowCount: 35,
          previousWindowCount: 15,
          trend: 20,
          modeCounts: { FT8: 28 },
          directionCounts: { SW: 12 },
          pathCounts: { "AF->EU": 12 },
          uniqueSenderLocatorCount: 8,
          uniqueReceiverLocatorCount: 7,
        },
      ],
    })],
    ["psk:freshness", new Date(now).toISOString()],
    ["solar:current", JSON.stringify({
      sfi: 160,
      kp: 2,
      aIndex: 5,
      sunspots: 110,
      muf: 24,
      updatedAt: new Date(now).toISOString(),
    })],
    ["psk:band:20m:dir:W", "22"],
    ["psk:band:17m:dir:SW", "14"],
  ]);

  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async zRangeByScore() {
      return rawSpots;
    },
  };
}
