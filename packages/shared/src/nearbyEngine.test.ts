import assert from "node:assert/strict";
import test from "node:test";

import { findNearbyOpportunities } from "./nearbyEngine.js";
import type { ParsedSpot } from "./types.js";

test("prefers nearby portable opportunities and exposes distance", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const result = findNearbyOpportunities(
    { homeGrid: "IO63UI" },
    [
      createSpot("EI7ABC/P", "IO63VG", "40m", "2026-03-15T11:59:10.000Z", ["FT8"], "SOTA summit"),
      createSpot("EA8ABC", "IL18AB", "20m", "2026-03-15T11:58:00.000Z", ["FT8"], "CQ DX"),
    ],
    undefined,
    now,
  );

  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0]?.callsign, "EI7ABC/P");
  assert.equal(result.cards[0]?.portableType, "SOTA");
  assert.equal(result.cards[0]?.entity, "Ireland");
  assert.ok(typeof result.cards[0]?.distanceKm === "number");
  assert.equal(result.candidates[0]?.callsign, "EI7ABC/P");
});

test("detects portable context from callsign suffixes and comment text", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const result = findNearbyOpportunities(
    { homeGrid: "IO63UI" },
    [
      createSpot("EI7MOB/M", "IO63VG", "40m", "2026-03-15T11:59:10.000Z", ["FT8"], "portable"),
      createSpot("EI7PARK", "IO63VG", "40m", "2026-03-15T11:59:05.000Z", ["FT8"], "POTA activation"),
      createSpot("EI7SUM", "IO63VG", "40m", "2026-03-15T11:59:00.000Z", ["FT8"], "SOTA summit"),
    ],
    undefined,
    now,
  );

  const portableTypes = result.candidates.map((candidate) => candidate.portableType);
  assert.ok(portableTypes.includes("Portable"));
  assert.ok(portableTypes.includes("POTA"));
  assert.ok(portableTypes.includes("SOTA"));
});

function createSpot(
  callsign: string,
  dxLocator: string,
  band: string,
  observedAt: string,
  tags: readonly ParsedSpot["tags"][number][],
  comment: string,
) {
  return {
    id: `${callsign}|${observedAt}`,
    source: "dxheat",
    spotterCallsign: "EI2TEST",
    spottedCallsign: callsign,
    countryCode: "IE",
    dxLocator,
    frequencyKHz: band === "40m" ? 7074 : 14074,
    band: band as ParsedSpot["band"],
    observedAt,
    mode: "ft8" as const,
    modeFamily: "digital" as const,
    comment,
    tags,
    receivedAt: observedAt,
  };
}
