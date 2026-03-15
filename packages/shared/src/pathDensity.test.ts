import assert from "node:assert/strict";
import test from "node:test";

import {
  computePropagationBandDensity,
  getAllBandPathDensities,
  getBandPathDensity,
  getDominantDirection,
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
  assert.equal(density.direction, "SE");
  assert.equal(density.sector, "E-SE");
  assert.equal(density.confidence, "Medium");
  assert.equal(density.densities.SE, 0.24);
  assert.equal(density.heading, 113);
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

test("computes dominant direction metadata from a density map", () => {
  const dominant = getDominantDirection({
    N: 0.08,
    NE: 0.12,
    E: 0.15,
    SE: 0.24,
    S: 0.1,
    SW: 0.07,
    W: 0.17,
    NW: 0.07,
  });

  assert.equal(dominant.direction, "SE");
  assert.equal(dominant.sector, "E-SE");
  assert.equal(dominant.confidence, "Medium");
  assert.equal(dominant.heading, 113);
});

test("loads all band path densities", async () => {
  const values = new Map<string, string>([
    ["psk:band:20m:dir:E", "12"],
    ["psk:band:20m:dir:SE", "18"],
    ["psk:band:15m:dir:W", "9"],
  ]);

  const densities = await getAllBandPathDensities({
    async get(key: string) {
      return values.get(key) ?? null;
    },
  });

  assert.ok(densities["20m"]);
  assert.ok(densities["15m"]);
  assert.equal(densities["20m"]?.dominantDirection, "SE");
});
