import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPskReporterSummary,
  parsePskReporterPayload,
} from "./psk-reporter.js";

test("normalizes generic psk reporter records", () => {
  const reports = parsePskReporterPayload({
    reports: [
      {
        senderCallsign: "ea8abc",
        receiverCallsign: "ei2test",
        senderLocator: "IL18",
        receiverLocator: "IO63UI",
        frequency: "14074000",
        mode: "ft8",
        flowStartSeconds: "1773572100",
      },
    ],
  });

  assert.deepEqual(reports, [{
    txCallsign: "EA8ABC",
    rxCallsign: "EI2TEST",
    txGrid: "IL18",
    rxGrid: "IO63UI",
    band: "20m",
    mode: "FT8",
    observedAt: "2026-03-15T10:55:00.000Z",
  }]);
});

test("builds rolling per-band counts, direction counts, and trend", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const summary = buildPskReporterSummary([
    {
      txCallsign: "K1AAA",
      rxCallsign: "EI2TEST",
      txGrid: "FN31PR",
      rxGrid: "IO63UI",
      band: "20m",
      mode: "FT8",
      observedAt: "2026-03-15T11:55:00.000Z",
    },
    {
      txCallsign: "W1BBB",
      rxCallsign: "EI2TEST",
      txGrid: "FN20AB",
      rxGrid: "IO63UI",
      band: "20m",
      mode: "FT8",
      observedAt: "2026-03-15T11:52:00.000Z",
    },
    {
      txCallsign: "JA1OLD",
      rxCallsign: "EI2TEST",
      txGrid: "PM95TU",
      rxGrid: "IO63UI",
      band: "20m",
      mode: "FT8",
      observedAt: "2026-03-15T11:35:00.000Z",
    },
  ], now);

  assert.equal(summary.windowMinutes, 15);
  assert.equal(summary.bands.length, 1);
  assert.equal(summary.bands[0]?.band, "20m");
  assert.equal(summary.bands[0]?.reportCount, 2);
  assert.equal(summary.bands[0]?.previousReportCount, 1);
  assert.equal(summary.bands[0]?.trend, 1);
  assert.equal(summary.bands[0]?.directionCounts.W, 2);
});
