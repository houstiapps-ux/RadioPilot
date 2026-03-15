import assert from "node:assert/strict";
import test from "node:test";

import { summarizeSpotNormalization } from "./normalizationAudit.js";
import { parseDxClusterLine } from "./parser.js";
import type { ParsedSpot } from "./types.js";

test("summarizes derived bands, portable detection, unresolved entities, and missing freshness", () => {
  const spots: ParsedSpot[] = [
    {
      id: "1",
      source: "dxheat",
      spotterCallsign: "EI2TEST",
      spottedCallsign: "EI7ABC/P",
      frequencyKHz: 7074,
      band: null,
      observedAt: "2026-03-15T11:59:00.000Z",
      comment: "SOTA activation",
      tags: ["SOTA", "/P", "FT8"],
    },
    {
      id: "2",
      source: "dxheat",
      spotterCallsign: "EI2TEST",
      spottedCallsign: "UNKNOWN1",
      frequencyKHz: 999999,
      band: null,
      comment: "no timestamp",
      tags: [],
    },
    {
      id: "3",
      source: "dxheat",
      spotterCallsign: "EI2TEST",
      spottedCallsign: "K1ABC",
      countryCode: "US",
      frequencyKHz: 14074,
      band: "20m",
      observedAt: "2026-03-15T11:58:00.000Z",
      comment: "CQ FT8",
      tags: ["FT8"],
    },
  ];

  assert.deepEqual(summarizeSpotNormalization(spots), {
    derivedBandCount: 1,
    unknownBandCount: 1,
    portableDetectedCount: 1,
    unresolvedEntityCount: 2,
    missingFreshnessTimestampCount: 1,
  });
});

test("parses representative mode tags from DX cluster comments", () => {
  assert.deepEqual(parseDxClusterLine("DX de EI4ABC: 14074.0 K1XYZ CQ FT8")?.tags, ["FT8"]);
  assert.deepEqual(parseDxClusterLine("DX de EI4ABC: 14074.0 K1XYZ CQ FT4")?.tags, ["FT4"]);
  assert.deepEqual(parseDxClusterLine("DX de EI4ABC: 14250.0 K1XYZ CQ SSB")?.tags, ["SSB"]);
  assert.deepEqual(parseDxClusterLine("DX de EI4ABC: 7020.0 K1XYZ CQ CW")?.tags, ["CW"]);
});
