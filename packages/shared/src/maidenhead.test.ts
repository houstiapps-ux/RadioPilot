import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveContinentFromLatLon,
  deriveContinentFromMaidenhead,
  estimatePathBetweenLocators,
  maidenheadToLatLon,
  parseMaidenheadLocator,
} from "./maidenhead.js";

test("parses valid Maidenhead locators", () => {
  assert.deepEqual(parseMaidenheadLocator("io63ui"), {
    normalized: "IO63UI",
    precision: 6,
  });
});

test("rejects invalid Maidenhead locators", () => {
  assert.equal(parseMaidenheadLocator("I963"), null);
  assert.equal(parseMaidenheadLocator("ZZ99"), null);
  assert.equal(parseMaidenheadLocator("IO6"), null);
});

test("converts a Maidenhead locator to approximate lat lon", () => {
  const coordinates = maidenheadToLatLon("IO63UI");

  assert.ok(coordinates);
  assert.ok(Math.abs(coordinates.latitude - 53.354) < 0.05);
  assert.ok(Math.abs(coordinates.longitude - -6.292) < 0.05);
});

test("derives a coarse continent from coordinates", () => {
  assert.equal(deriveContinentFromLatLon({ latitude: 53.35, longitude: -6.26 }), "EU");
  assert.equal(deriveContinentFromLatLon({ latitude: 40.73, longitude: -73.93 }), "NA");
  assert.equal(deriveContinentFromLatLon({ latitude: -33.86, longitude: 151.21 }), "OC");
});

test("derives a coarse continent from Maidenhead locators", () => {
  assert.equal(deriveContinentFromMaidenhead("IO63UI"), "EU");
  assert.equal(deriveContinentFromMaidenhead("FN30AS"), "NA");
  assert.equal(deriveContinentFromMaidenhead("QF56OD"), "OC");
  assert.equal(deriveContinentFromMaidenhead(""), undefined);
});

test("estimates distance and direction between locators", () => {
  const estimate = estimatePathBetweenLocators("IO63UI", "FN30AS");

  assert.ok(estimate);
  assert.ok(estimate.distanceKm > 4_500);
  assert.ok(estimate.distanceKm < 6_000);
  assert.equal(estimate.direction, "W");
});
