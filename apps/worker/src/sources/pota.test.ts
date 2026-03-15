import assert from "node:assert/strict";
import test from "node:test";

import { parsePotaPayload } from "./pota.js";

test("normalizes pota activations into shared structure", () => {
  const activations = parsePotaPayload({
    activations: [{
      parkCode: "K-1234",
      activator: "K1ABC/P",
      band: "20m",
      mode: "ssb",
      grid: "FN31PR",
      latitude: "41.50",
      longitude: "-72.70",
      spotTime: "2026-03-15T12:05:00Z",
    }],
  });

  assert.deepEqual(activations, [{
    id: "pota:K-1234:K1ABC/P:2026-03-15T12:05:00.000Z",
    programme: "POTA",
    reference: "K-1234",
    callsign: "K1ABC/P",
    band: "20m",
    mode: "SSB",
    locator: "FN31PR",
    latitude: 41.5,
    longitude: -72.7,
    observedAt: "2026-03-15T12:05:00.000Z",
  }]);
});
