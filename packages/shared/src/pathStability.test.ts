import assert from "node:assert/strict";
import test from "node:test";

import { calculatePathStability } from "./pathStability.js";

test("calculates a strong path stability score for sustained supported activity", () => {
  const result = calculatePathStability({
    pskCurrent: 42,
    pskPrevious: 34,
    directionConfidence: "High",
    directionSpread: 5,
    currentCallsignSpots: 4,
    totalSpots: 7,
    freshnessSeconds: 45,
  });

  assert.ok(result);
  assert.equal(result?.pathStability, "Strong");
  assert.ok((result?.pathStabilityScore ?? 0) > 0.7);
});

test("calculates weak stability for sparse fading evidence", () => {
  const result = calculatePathStability({
    pskCurrent: 0,
    pskPrevious: 8,
    directionConfidence: "Low",
    directionSpread: 0,
    currentCallsignSpots: 1,
    totalSpots: 5,
    freshnessSeconds: 900,
  });

  assert.ok(result);
  assert.equal(result?.pathStability, "Weak");
  assert.ok((result?.pathStabilityScore ?? 1) < 0.4);
});
