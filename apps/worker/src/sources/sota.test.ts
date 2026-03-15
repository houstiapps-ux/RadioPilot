import assert from "node:assert/strict";
import test from "node:test";

import { parseSotaPayload } from "./sota.js";

test("normalizes sota activations into shared structure", () => {
  const activations = parseSotaPayload({
    activations: [{
      summitCode: "EI/IE-012",
      activatorCallsign: "EI2TEST/P",
      frequency: "7032",
      mode: "cw",
      locator: "IO63UI",
      time: "2026-03-15T11:20:00Z",
    }],
  });

  assert.deepEqual(activations, [{
    id: "sota:EI/IE-012:EI2TEST/P:2026-03-15T11:20:00.000Z",
    programme: "SOTA",
    reference: "EI/IE-012",
    callsign: "EI2TEST/P",
    band: "40m",
    mode: "CW",
    locator: "IO63UI",
    latitude: undefined,
    longitude: undefined,
    observedAt: "2026-03-15T11:20:00.000Z",
  }]);
});
