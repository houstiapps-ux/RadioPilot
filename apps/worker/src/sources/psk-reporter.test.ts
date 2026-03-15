import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPskReporterSummary,
  buildPskReporterTopics,
  startPskReporterMqttIngestion,
  parsePskReporterPayload,
} from "./psk-reporter.js";

test("normalizes generic psk reporter records", () => {
  const parsed = parsePskReporterPayload({
    senderCallsign: "ea8abc",
    receiverCallsign: "ei2test",
    senderLocator: "IL18",
    receiverLocator: "IO63UI",
    frequency: "14074000",
    mode: "ft8",
    flowStartSeconds: "1773572100",
  });

  assert.deepEqual(parsed, {
    discardReasons: [],
    reports: [{
    observedAt: "2026-03-15T10:55:00.000Z",
    frequencyHz: 14074000,
    band: "20m",
    mode: "FT8",
    senderCallsign: "EA8ABC",
    senderLocator: "IL18",
    receiverCallsign: "EI2TEST",
    receiverLocator: "IO63UI",
    }],
  });
});

test("builds rolling per-band counts, direction counts, and trend", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const summary = buildPskReporterSummary([
    {
      observedAt: "2026-03-15T11:55:00.000Z",
      frequencyHz: 14074000,
      band: "20m",
      mode: "FT8",
      senderCallsign: "K1AAA",
      senderLocator: "FN31PR",
      receiverCallsign: "EI2TEST",
      receiverLocator: "IO63UI",
    },
    {
      observedAt: "2026-03-15T11:52:00.000Z",
      frequencyHz: 14074000,
      band: "20m",
      mode: "FT8",
      senderCallsign: "W1BBB",
      senderLocator: "FN20AB",
      receiverCallsign: "EI2TEST",
      receiverLocator: "IO63UI",
    },
    {
      observedAt: "2026-03-15T11:35:00.000Z",
      frequencyHz: 14074000,
      band: "20m",
      mode: "FT8",
      senderCallsign: "JA1OLD",
      senderLocator: "PM95TU",
      receiverCallsign: "EI2TEST",
      receiverLocator: "IO63UI",
    },
  ], now);

  assert.equal(summary.windowMinutes, 15);
  assert.equal(summary.bands.length, 1);
  assert.equal(summary.bands[0]?.band, "20m");
  assert.equal(summary.bands[0]?.currentWindowCount, 2);
  assert.equal(summary.bands[0]?.previousWindowCount, 1);
  assert.equal(summary.bands[0]?.trend, 1);
  assert.equal(summary.bands[0]?.modeCounts.FT8, 2);
  assert.equal(summary.bands[0]?.directionCounts.W, 2);
  assert.equal(summary.bands[0]?.pathCounts["NA->EU"], 2);
  assert.equal(summary.bands[0]?.uniqueSenderLocatorCount, 2);
  assert.equal(summary.bands[0]?.uniqueReceiverLocatorCount, 1);
});

test("builds shared MQTT topics for supported bands and modes", () => {
  const topics = buildPskReporterTopics();

  assert.ok(topics.includes("pskr/filter/v2/20m/FT8/+/+/+/+/+/+"));
  assert.ok(topics.includes("pskr/filter/v2/20m/FT4/+/+/+/+/+/+"));
  assert.ok(topics.includes("pskr/filter/v2/6m/FT8/+/+/+/+/+/+"));
  assert.equal(topics.length, 24);
});

test("mock mode feeds the same ingestion pipeline", async () => {
  process.env.MOCK_PSK = "true";
  const summaries: unknown[] = [];
  const metrics: unknown[] = [];
  const handle = startPskReporterMqttIngestion({
    onSummary: async (summary) => {
      summaries.push(summary);
    },
    onMetrics: async (value) => {
      metrics.push(value);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5_500));
  await handle.stop();
  delete process.env.MOCK_PSK;

  assert.ok(metrics.length >= 1);
  assert.ok(summaries.length >= 1);
});
