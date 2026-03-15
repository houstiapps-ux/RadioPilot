import assert from "node:assert/strict";
import test from "node:test";

import {
  computePropagationBandDensity,
  getBandPathDensity,
} from "./pathDensity.js";

test("computes directional densities and dominant sector", () => {
  const density = computePropagationBandDensity({
    N: 8,
    NE: 12,
    E: 15,
    SE: 24,
    S: 10,
    SW: 7,
    W: 17,
    NW: 7,
  });

  assert.equal(density.dominantDirection, "SE");
  assert.equal(density.sector, "E-SE");
  assert.equal(density.confidence, "Medium");
  assert.equal(density.densities.SE, 0.24);
  assert.equal(density.beamHeading, 113);
});

test("loads band path density from redis-style direction keys", async () => {
  const values = new Map<string, string>([
    ["psk:band:20m:dir:N", "5"],
    ["psk:band:20m:dir:NE", "7"],
    ["psk:band:20m:dir:E", "11"],
    ["psk:band:20m:dir:SE", "18"],
    ["psk:band:20m:dir:S", "6"],
    ["psk:band:20m:dir:SW", "4"],
    ["psk:band:20m:dir:W", "9"],
    ["psk:band:20m:dir:NW", "4"],
  ]);

  const density = await getBandPathDensity({
    async get(key: string) {
      return values.get(key) ?? null;
    },
  }, "20m");

  assert.equal(density.dominantDirection, "SE");
  assert.ok((density.densities.SE ?? 0) > 0.25);
});
