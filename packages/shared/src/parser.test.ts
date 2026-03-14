import assert from "node:assert/strict";
import test from "node:test";

import { parseDxClusterLine } from "./parser.js";

test("parses a basic CW spot", () => {
  const parsed = parseDxClusterLine("DX de EI4ABC: 14074.0 K1XYZ CQ CQ CW");

  assert.ok(parsed);
  assert.equal(parsed.spotterCallsign, "EI4ABC");
  assert.equal(parsed.spottedCallsign, "K1XYZ");
  assert.equal(parsed.frequencyKHz, 14074);
  assert.equal(parsed.band, "20m");
  assert.equal(parsed.comment, "CQ CQ CW");
  assert.deepEqual(parsed.tags, ["CW"]);
});

test("detects multiple tags from trailing text", () => {
  const parsed = parseDxClusterLine(
    "DX de W3AAA: 7036.0 EA8/AB1C POTA SOTA FT8 strong signal",
  );

  assert.ok(parsed);
  assert.equal(parsed.band, "40m");
  assert.deepEqual(parsed.tags, ["SOTA", "POTA", "FT8"]);
});

test("parses slash callsigns and FT4 mode", () => {
  const parsed = parseDxClusterLine("DX de F4XYZ: 21074.5 ZL4/N0CALL FT4");

  assert.ok(parsed);
  assert.equal(parsed.spotterCallsign, "F4XYZ");
  assert.equal(parsed.spottedCallsign, "ZL4/N0CALL");
  assert.equal(parsed.band, "15m");
  assert.deepEqual(parsed.tags, ["FT4"]);
});

test("parses empty trailing text", () => {
  const parsed = parseDxClusterLine("DX de G4AAA: 18100.0 VK9DX");

  assert.ok(parsed);
  assert.equal(parsed.comment, "");
  assert.equal(parsed.band, "17m");
  assert.deepEqual(parsed.tags, []);
});

test("detects SSB in free text", () => {
  const parsed = parseDxClusterLine(
    "DX de K9BBB: 14250.0 LU1DZ calling CQ on SSB",
  );

  assert.ok(parsed);
  assert.equal(parsed.band, "20m");
  assert.deepEqual(parsed.tags, ["SSB"]);
});

test("returns null for non-DX lines", () => {
  const parsed = parseDxClusterLine("WWV de NIST: solar flux 120");

  assert.equal(parsed, null);
});
