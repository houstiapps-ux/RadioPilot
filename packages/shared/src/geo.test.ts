import assert from "node:assert/strict";
import test from "node:test";

import { distanceKm, gridToLatLon } from "./geo.js";

test("converts a Maidenhead locator to coordinates", () => {
  const coordinates = gridToLatLon("IO63UI");

  assert.ok(coordinates);
  assert.ok(coordinates.latitude > 52);
  assert.ok(coordinates.latitude < 54);
  assert.ok(coordinates.longitude < 0);
});

test("computes haversine distance between Maidenhead locators", () => {
  const distance = distanceKm("IO63UI", "IO91WM");

  assert.ok(distance);
  assert.ok(distance > 350);
  assert.ok(distance < 600);
});
