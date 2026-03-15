import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpportunitySnapshot,
  parseStoredOpportunitySpot,
  type StoredOpportunitySpot,
} from "./opportunities.js";

test("enriches opportunities with dominant direction, bearing, region, and confidence", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const spots: StoredOpportunitySpot[] = [
    createSpot("K1AAA", "FN31PR", "phone", "2026-03-15T11:55:00.000Z"),
    createSpot("W1BBB", "FN20AB", "cw", "2026-03-15T11:56:00.000Z"),
    createSpot("VE3CCC", "FN03CD", "digital", "2026-03-15T11:57:00.000Z"),
    createSpot("JA1OLD", "PM95TU", "digital", "2026-03-15T11:35:00.000Z"),
  ];

  const snapshot = buildOpportunitySnapshot(spots, {
    now,
    homeGrid: "IO63UI",
    operatingStyle: "dx",
  });

  assert.ok(snapshot.bestOpportunity);
  assert.equal(snapshot.bestOpportunity.direction, "West");
  assert.ok(typeof snapshot.bestOpportunity.bearing === "number");
  assert.equal(snapshot.bestOpportunity.region, "North America");
  assert.equal(snapshot.bestOpportunity.confidence, "High");
  assert.match(snapshot.bestOpportunity.summary, /North America opening/);
  assert.match(snapshot.bestOpportunity.summary, /West \(\d+°\)/);
});

test("preserves countryCode from stored spots into generated opportunity cards", () => {
  const observedAt = "2026-03-15T11:58:00.000Z";
  const [storedSpot] = parseStoredOpportunitySpot(JSON.stringify({
    id: "spot-1",
    source: "dxheat",
    spotterCallsign: "EI2TEST",
    spottedCallsign: "EA8ABC",
    continentDx: "AF",
    countryCode: "ES",
    dxLocator: "IL18",
    frequencyKHz: 14074.5,
    band: "20m",
    observedAt,
    mode: "ft8",
    modeFamily: "digital",
    comment: "CQ DX",
    tags: ["FT8"],
    receivedAt: observedAt,
  }));

  assert.ok(storedSpot);
  assert.equal(storedSpot.countryCode, "ES");

  const snapshot = buildOpportunitySnapshot([storedSpot], {
    now: Date.parse("2026-03-15T12:00:00.000Z"),
    homeGrid: "IO63UI",
  });

  assert.ok(snapshot.bestOpportunity);
  assert.equal(snapshot.bestOpportunity.countryCode, "ES");
  assert.equal(snapshot.cards[0]?.countryCode, "ES");
  assert.equal(snapshot.dxOpportunity?.countryCode, "ES");
});

test("uses the representative spot locator for card direction and bearing", () => {
  const observedAt = "2026-03-15T11:58:00.000Z";
  const [storedSpot] = parseStoredOpportunitySpot(JSON.stringify({
    id: "spot-direction-1",
    source: "dxheat",
    spotterCallsign: "EI2TEST",
    spottedCallsign: "K1ABC",
    continentDx: "NA",
    dxLocator: "FN31PR",
    frequencyKHz: 14250,
    band: "20m",
    observedAt,
    mode: "ssb",
    modeFamily: "phone",
    comment: "CQ",
    tags: [],
    receivedAt: observedAt,
  }));

  assert.ok(storedSpot);

  const snapshot = buildOpportunitySnapshot([storedSpot], {
    now: Date.parse("2026-03-15T12:00:00.000Z"),
    homeGrid: "IO63UI",
  });

  assert.ok(snapshot.bestOpportunity);
  assert.equal(snapshot.bestOpportunity.direction, "West");
  assert.ok(typeof snapshot.bestOpportunity.bearing === "number");
  assert.ok(snapshot.bestOpportunity.bearing >= 250);
  assert.ok(snapshot.bestOpportunity.bearing <= 310);
  assert.equal(snapshot.watchNext.length, 0);
  assert.equal(snapshot.dxOpportunity?.direction, "West");
});

function createSpot(
  callsign: string,
  dxLocator: string,
  modeFamily: StoredOpportunitySpot["modeFamily"],
  observedAt: string,
): StoredOpportunitySpot {
  return {
    id: `${callsign}|${observedAt}`,
    source: "dxheat",
    spotterCallsign: "EI2TEST",
    spottedCallsign: callsign,
    continentDx: "NA",
    dxLocator,
    frequencyKHz: 14250,
    band: "20m",
    observedAt,
    mode: modeFamily === "phone" ? "ssb" : modeFamily === "cw" ? "cw" : "ft8",
    modeFamily,
    comment: "Test spot",
    tags: [],
    receivedAt: observedAt,
  };
}
