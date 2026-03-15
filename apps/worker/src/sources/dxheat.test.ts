import assert from "node:assert/strict";
import test from "node:test";

import { parseDxHeatPayload, parseDxHeatRecord } from "./dxheat.js";

test("maps a DXHeat JSON record into a parsed spot", () => {
  const parsed = parseDxHeatRecord({
    Nr: 12,
    DXCall: "EA8/AB1C/P",
    Spotter: "EI4ABC",
    Frequency: "14074.5",
    Date: "15/03/26",
    Time: "09:12",
    Mode: "DIGITAL",
    Comment: "SOTA POTA WWFF FT8 loud copy",
  });

  assert.ok(parsed);
  assert.equal(parsed.spotterCallsign, "EI4ABC");
  assert.equal(parsed.spottedCallsign, "EA8/AB1C/P");
  assert.equal(parsed.id, "12");
  assert.equal(parsed.source, "dxheat");
  assert.equal(parsed.frequencyHz, 14074500);
  assert.equal(parsed.frequencyKHz, 14074.5);
  assert.equal(parsed.band, "20m");
  assert.equal(parsed.observedAt, "2026-03-15T09:12:00.000Z");
  assert.equal(parsed.mode, "ft8");
  assert.equal(parsed.modeFamily, "digital");
  assert.deepEqual(parsed.tags, ["SOTA", "POTA", "WWFF", "/P", "FT8"]);
});

test("normalizes phone and generic digital modes", () => {
  const phone = parseDxHeatRecord({
    Nr: "1",
    DXCall: "K1XYZ",
    Frequency: "14250.0",
    Date: "15/03/26",
    Time: "0912",
    Mode: "USB",
    Comment: "calling cq",
  });
  const digital = parseDxHeatRecord({
    Nr: "2",
    DXCall: "K1XYZ",
    Frequency: "7074.0",
    Date: "15/03/26",
    Time: "09:13:30",
    Mode: "DIGITAL",
    Comment: "MFSK test",
  });

  assert.ok(phone);
  assert.equal(phone.mode, "ssb");
  assert.equal(phone.modeFamily, "phone");
  assert.ok(digital);
  assert.equal(digital.mode, "digital");
  assert.equal(digital.modeFamily, "digital");
});

test("uses unknown mode metadata when the mode is not recognised", () => {
  const parsed = parseDxHeatRecord({
    Nr: "3",
    DXCall: "K1XYZ",
    Frequency: "7074.0",
    Date: "15/03/26",
    Time: "09:14",
    Mode: "OLIVIA",
    Comment: "test",
  });

  assert.ok(parsed);
  assert.equal(parsed.mode, "unknown");
  assert.equal(parsed.modeFamily, "unknown");
});

test("ignores invalid records missing required fields", () => {
  const parsed = parseDxHeatPayload([
    {
      Nr: 1,
      DXCall: "K1XYZ",
      Frequency: "14074.0",
      Date: "15/03/26",
      Time: "09:12",
      Mode: "CW",
    },
    {
      DXCall: "K1XYZ",
      Frequency: "14074.0",
      Date: "15/03/26",
      Time: "09:12",
    },
    {
      Nr: 2,
      DXCall: "K1XYZ",
      Frequency: "bad",
      Date: "15/03/26",
      Time: "09:12",
    },
  ]);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.mode, "cw");
  assert.equal(parsed[0]?.modeFamily, "cw");
});
