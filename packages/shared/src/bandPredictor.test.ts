import assert from "node:assert/strict";
import test from "node:test";

import { computeBandPrediction, predictBandOpenings } from "./bandPredictor.js";

test("predicts an opening band from stronger current PSK activity and solar support", () => {
  const prediction = computeBandPrediction(
    "10m",
    {
      count: 80,
      uniqueCalls: 42,
      uniqueGrids: 30,
      modes: { FT8: 60, FT4: 8 },
      updatedAt: Date.now(),
    },
    {
      count: 40,
      uniqueCalls: 18,
      uniqueGrids: 12,
      modes: { FT8: 32, FT4: 4 },
      updatedAt: Date.now() - 900_000,
    },
    { N: 2, NE: 4, E: 5, SE: 6, S: 4, SW: 3, W: 20, NW: 2 },
    {
      updatedAt: new Date().toISOString(),
      muf: 30,
      sfi: 165,
      kp: 2,
    },
  );

  assert.equal(prediction.state, "opening");
  assert.ok(prediction.score > 0.7);
  assert.ok(prediction.signals.includes("10m activity rising"));
});

test("loads per-band predictions from redis-like keys", async () => {
  const values = new Map<string, string>([
    ["psk:band:15m:current", JSON.stringify({
      count: 42,
      uniqueCalls: 20,
      uniqueGrids: 16,
      modes: { FT8: 32, FT4: 4 },
      updatedAt: Date.now(),
    })],
    ["psk:band:15m:previous", JSON.stringify({
      count: 24,
      uniqueCalls: 10,
      uniqueGrids: 8,
      modes: { FT8: 18, FT4: 2 },
      updatedAt: Date.now() - 900_000,
    })],
    ["psk:band:15m:dir:W", "15"],
    ["psk:band:15m:dir:E", "2"],
    ["solar:current", JSON.stringify({
      updatedAt: new Date().toISOString(),
      muf: 25,
      sfi: 150,
      kp: 2,
    })],
  ]);

  const predictions = await predictBandOpenings({
    async get(key: string) {
      return values.get(key) ?? null;
    },
  }, {});

  assert.ok(predictions["15m"]);
  assert.equal(predictions["15m"]?.state, "opening");
});
