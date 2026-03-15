import assert from "node:assert/strict";
import test from "node:test";

import {
  computeBandTrend,
  getAllBandTrends,
} from "./pskTrends.js";

test("computes rising band trends from current and previous windows", () => {
  const trend = computeBandTrend(
    {
      count: 84,
      uniqueCalls: 42,
      uniqueGrids: 35,
      modes: { FT8: 70, FT4: 14 },
      updatedAt: Date.now(),
    },
    {
      count: 50,
      uniqueCalls: 28,
      uniqueGrids: 20,
      modes: { FT8: 44, FT4: 6 },
      updatedAt: Date.now() - 15_000,
    },
  );

  assert.equal(trend.trend, "rising");
  assert.equal(trend.confidence, "High");
  assert.ok(trend.volumeDelta > 0.2);
  assert.ok(trend.gridDelta > 0.2);
});

test("loads all band trends from Redis-style windows", async () => {
  const values = new Map<string, string | null>([
    ["psk:band:20m:current", JSON.stringify({
      count: 80,
      uniqueCalls: 38,
      uniqueGrids: 30,
      modes: { FT8: 70, FT4: 10 },
      updatedAt: Date.now(),
    })],
    ["psk:band:20m:previous", JSON.stringify({
      count: 40,
      uniqueCalls: 22,
      uniqueGrids: 18,
      modes: { FT8: 36, FT4: 4 },
      updatedAt: Date.now() - 15_000,
    })],
    ["psk:band:15m:current", JSON.stringify({
      count: 22,
      uniqueCalls: 14,
      uniqueGrids: 11,
      modes: { FT8: 20, FT4: 2 },
      updatedAt: Date.now(),
    })],
    ["psk:band:15m:previous", JSON.stringify({
      count: 24,
      uniqueCalls: 15,
      uniqueGrids: 11,
      modes: { FT8: 22, FT4: 2 },
      updatedAt: Date.now() - 15_000,
    })],
  ]);

  const trends = await getAllBandTrends({
    async get(key: string) {
      return values.get(key) ?? null;
    },
  });

  assert.equal(trends["20m"]?.trend, "rising");
  assert.equal(trends["15m"]?.trend, "steady");
});
