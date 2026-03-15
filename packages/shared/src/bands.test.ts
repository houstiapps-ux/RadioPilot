import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveBandFromFrequencyKhz,
  isValidBand,
  resolveBand,
} from "./bands.js";

test("derives common amateur bands from frequency", () => {
  assert.equal(deriveBandFromFrequencyKhz(7074), "40m");
  assert.equal(deriveBandFromFrequencyKhz(14085), "20m");
  assert.equal(deriveBandFromFrequencyKhz(432100), "70cm");
});

test("keeps a valid source band and falls back when source band is invalid", () => {
  assert.equal(resolveBand("20m", 7074), "20m");
  assert.equal(resolveBand("unknown", 7074), "40m");
  assert.equal(resolveBand(null, 999999), null);
  assert.equal(isValidBand("17m"), true);
  assert.equal(isValidBand("unknown"), false);
});
