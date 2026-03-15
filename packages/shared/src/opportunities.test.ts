import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpportunitySnapshot,
  buildOpportunitySnapshotWithDebug,
  parseStoredOpportunitySpot,
  summarizeStoredSpotBandResolution,
  type StoredOpportunitySpot,
} from "./opportunities.js";
import type { PskReporterSummary } from "./types.js";

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
  assert.equal(snapshot.bestOpportunity.directionConfidence, "Low");
  assert.equal(snapshot.bestOpportunity.pathStability, "Moderate");
  assert.ok(typeof snapshot.bestOpportunity.pathStabilityScore === "number");
  assert.equal(snapshot.bestOpportunity.cardType, "best");
  assert.equal(snapshot.bestOpportunity.bandState, "Opening");
  assert.ok(Array.isArray(snapshot.bestOpportunity.signals));
  assert.ok(Array.isArray(snapshot.bestOpportunity.why));
  assert.ok(typeof snapshot.bestOpportunity.actionLine === "string");
  assert.ok(typeof snapshot.bestOpportunity.frequencyMhz === "string");
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

test("derives band from frequency when stored band is missing or invalid", () => {
  const [missingBandSpot] = parseStoredOpportunitySpot(JSON.stringify({
    id: "spot-band-1",
    source: "dxheat",
    spotterCallsign: "EI2TEST",
    spottedCallsign: "K1ABC",
    dxLocator: "FN31PR",
    frequencyKHz: 7074,
    band: "unknown",
    observedAt: "2026-03-15T11:58:00.000Z",
    mode: "ft8",
    modeFamily: "digital",
    comment: "CQ",
    tags: ["FT8"],
    receivedAt: "2026-03-15T11:58:05.000Z",
  }));

  assert.ok(missingBandSpot);
  assert.equal(missingBandSpot.band, "40m");

  const resolution = summarizeStoredSpotBandResolution([
    JSON.stringify({
      id: "spot-band-1",
      source: "dxheat",
      spotterCallsign: "EI2TEST",
      spottedCallsign: "K1ABC",
      dxLocator: "FN31PR",
      frequencyKHz: 7074,
      band: "unknown",
      observedAt: "2026-03-15T11:58:00.000Z",
      mode: "ft8",
      modeFamily: "digital",
      comment: "CQ",
      tags: ["FT8"],
      receivedAt: "2026-03-15T11:58:05.000Z",
    }),
    JSON.stringify({
      id: "spot-band-2",
      source: "dxheat",
      spotterCallsign: "EI2TEST",
      spottedCallsign: "K1XYZ",
      dxLocator: "FN20AB",
      frequencyKHz: 999999,
      observedAt: "2026-03-15T11:57:00.000Z",
      comment: "CQ",
      tags: [],
      receivedAt: "2026-03-15T11:57:05.000Z",
    }),
  ]);

  assert.deepEqual(resolution, {
    sourceBandMissing: 2,
    frequencyDerivedBandUsed: 1,
    unresolvedBand: 1,
  });
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

test("applies PSK summary boosts and exposes debug details", () => {
  const observedAt = "2026-03-15T11:58:00.000Z";
  const [storedSpot] = parseStoredOpportunitySpot(JSON.stringify({
    id: "spot-psk-1",
    source: "dxheat",
    spotterCallsign: "EI2TEST",
    spottedCallsign: "EA8ABC",
    continentDx: "AF",
    dxLocator: "IL18",
    frequencyKHz: 14074,
    band: "20m",
    observedAt,
    mode: "ft8",
    modeFamily: "digital",
    comment: "CQ",
    tags: ["FT8"],
    receivedAt: observedAt,
  }));

  const pskSummary: PskReporterSummary = {
    generatedAt: "2026-03-15T12:00:00.000Z",
    freshnessTimestamp: "2026-03-15T11:59:30.000Z",
    currentWindowStart: "2026-03-15T11:45:00.000Z",
    previousWindowStart: "2026-03-15T11:30:00.000Z",
    windowMinutes: 15,
    bands: [{
      band: "20m",
      currentWindowCount: 80,
      previousWindowCount: 40,
      trend: 40,
      modeCounts: { FT8: 60, FT4: 10 },
      directionCounts: { SW: 5 },
      pathCounts: { AF: 1 } as never,
      uniqueSenderLocatorCount: 10,
      uniqueReceiverLocatorCount: 8,
    }],
  };

  const debug = buildOpportunitySnapshotWithDebug([storedSpot], {
    now: Date.parse("2026-03-15T12:00:00.000Z"),
    homeGrid: "IO63UI",
    pskSummary,
  });

  assert.ok(debug.snapshot.bestOpportunity);
  assert.ok((debug.snapshot.bestOpportunity.score ?? 0) > 100);
  assert.equal(debug.bands[0]?.band, "20m");
  assert.equal(debug.bands[0]?.pskCurrent, 80);
  assert.equal(debug.bands[0]?.pskPrevious, 40);
  assert.equal(debug.bands[0]?.pskBoostApplied, true);
});

test("keeps confidence reason and evidence flags aligned when PSK is present", () => {
  const observedAt = "2026-03-15T11:58:00.000Z";
  const [storedSpot] = parseStoredOpportunitySpot(JSON.stringify({
    id: "spot-psk-2",
    source: "dxheat",
    spotterCallsign: "EI2TEST",
    spottedCallsign: "EA8ABC",
    continentDx: "AF",
    countryCode: "ES",
    dxLocator: "IL18",
    frequencyKHz: 14074,
    band: "20m",
    observedAt,
    mode: "ft8",
    modeFamily: "digital",
    comment: "CQ",
    tags: ["FT8"],
    receivedAt: observedAt,
  }));

  const pskSummary: PskReporterSummary = {
    generatedAt: "2026-03-15T12:00:00.000Z",
    freshnessTimestamp: "2026-03-15T11:59:30.000Z",
    currentWindowStart: "2026-03-15T11:45:00.000Z",
    previousWindowStart: "2026-03-15T11:30:00.000Z",
    windowMinutes: 15,
    bands: [{
      band: "20m",
      currentWindowCount: 8,
      previousWindowCount: 6,
      trend: 2,
      modeCounts: { FT8: 8 },
      directionCounts: { SE: 3 },
      pathCounts: { AF: 1 } as never,
      uniqueSenderLocatorCount: 4,
      uniqueReceiverLocatorCount: 4,
    }],
  };

  const snapshot = buildOpportunitySnapshot([storedSpot], {
    now: Date.parse("2026-03-15T12:00:00.000Z"),
    homeGrid: "IO63UI",
    pskSummary,
  });

  assert.equal(snapshot.bestOpportunity?.evidenceFlags?.psk, true);
  assert.equal(snapshot.bestOpportunity?.confidenceReason, "Path confirmed, but activity still light");
  assert.deepEqual(snapshot.bestOpportunity?.supportChips, ["Path weak"]);
});

test("prefers a rarer DX candidate over duplicating best opportunity", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const spots: StoredOpportunitySpot[] = [
    createSpot("K1AAA", "FN31PR", "digital", "2026-03-15T11:58:00.000Z"),
    createSpot("K1AAA", "FN31PR", "digital", "2026-03-15T11:57:00.000Z"),
    createSpot("FT4GL", "LH38", "digital", "2026-03-15T11:56:00.000Z"),
  ];

  const debug = buildOpportunitySnapshotWithDebug(spots, {
    now,
    homeGrid: "IO63UI",
    dxRarity: {
      generatedAt: now,
      callsigns: {
        K1AAA: 18,
        FT4GL: 1,
      },
      entities: {
        US: 24,
        FR: 1,
      },
    },
  });

  assert.equal(debug.snapshot.bestOpportunity?.callsign, "K1AAA");
  assert.equal(debug.snapshot.dxOpportunity?.callsign, "FT4GL");
  assert.ok(debug.dxCandidates.some((candidate) => candidate.callsign === "FT4GL"));
});

test("builds nearby activity from regional distance and portable context", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const snapshot = buildOpportunitySnapshot([
    createSpot("EI7ABC/P", "IO63VG", "digital", "2026-03-15T11:59:00.000Z"),
    createSpot("EA8ABC", "IL18", "digital", "2026-03-15T11:58:00.000Z"),
  ], {
    now,
    homeGrid: "IO63UI",
  });

  assert.equal(snapshot.nearbyActivity.length, 1);
  assert.equal(snapshot.nearbyActivity[0]?.callsign, "EI7ABC/P");
  assert.equal(snapshot.nearbyActivity[0]?.cardType, "nearby");
  assert.ok(typeof snapshot.nearbyActivity[0]?.distanceKm === "number");
});

test("applies request-time intent filters to ranking and band scope", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const snapshot = buildOpportunitySnapshot([
    createSpot("EI7ABC/P", "IO63VG", "digital", "2026-03-15T11:59:00.000Z", 7074, "40m", ["POTA", "/P", "FT8"]),
    createSpot("K1ABC", "FN31PR", "phone", "2026-03-15T11:58:00.000Z", 14250, "20m", ["SSB"]),
    createSpot("ON4CW", "JO20AB", "cw", "2026-03-15T11:57:00.000Z", 144174, "2m", ["CW"]),
  ], {
    now,
    homeGrid: "IO63UI",
    chasing: "pota",
    modeFilter: "digital",
    bandScope: "hf",
  });

  assert.equal(snapshot.bestOpportunity?.callsign, "EI7ABC/P");
  assert.equal(snapshot.dxOpportunity?.callsign, "EI7ABC/P");
  assert.ok(snapshot.nearbyActivity.every((card) => card.band !== "2m"));
});

test("chasing filters materially change best-opportunity ranking when a preferred match exists", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const snapshot = buildOpportunitySnapshot([
    createSpot("K1BIG", "FN31PR", "phone", "2026-03-15T11:59:00.000Z", 14250, "20m", ["SSB"]),
    createSpot("K1BIG", "FN31PR", "phone", "2026-03-15T11:58:30.000Z", 14250, "20m", ["SSB"]),
    createSpot("EA8LOUD", "IL18", "phone", "2026-03-15T11:58:00.000Z", 14250, "20m", ["SSB"]),
    createSpot("EI7ABC/P", "IO63VG", "digital", "2026-03-15T11:57:00.000Z", 7074, "40m", ["POTA", "/P", "FT8"]),
  ], {
    now,
    homeGrid: "IO63UI",
    chasing: "pota",
  });

  assert.equal(snapshot.bestOpportunity?.callsign, "EI7ABC/P");
});

test("returns no best opportunity when a chasing filter has no matching candidates", () => {
  const now = Date.parse("2026-03-15T12:00:00.000Z");
  const snapshot = buildOpportunitySnapshot([
    createSpot("K1ABC", "FN31PR", "phone", "2026-03-15T11:58:00.000Z", 14250, "20m", ["SSB"]),
    createSpot("EA8ABC", "IL18", "digital", "2026-03-15T11:57:00.000Z", 14074, "20m", ["FT8"]),
  ], {
    now,
    homeGrid: "IO63UI",
    chasing: "sota",
  });

  assert.equal(snapshot.bestOpportunity, null);
  assert.equal(snapshot.watchNext.length, 0);
  assert.equal(snapshot.nearbyActivity.length, 0);
});

function createSpot(
  callsign: string,
  dxLocator: string,
  modeFamily: StoredOpportunitySpot["modeFamily"],
  observedAt: string,
  frequencyKHz = 14250,
  band: StoredOpportunitySpot["band"] = "20m",
  tags: StoredOpportunitySpot["tags"] = [],
): StoredOpportunitySpot {
  return {
    id: `${callsign}|${observedAt}`,
    source: "dxheat",
    spotterCallsign: "EI2TEST",
    spottedCallsign: callsign,
    continentDx: callsign === "FT4GL" ? "AF" : callsign.startsWith("EI") ? "EU" : "NA",
    countryCode: callsign === "FT4GL" ? "FR" : callsign.startsWith("EI") ? "IE" : "US",
    dxLocator,
    frequencyKHz,
    band,
    observedAt,
    mode: modeFamily === "phone" ? "ssb" : modeFamily === "cw" ? "cw" : "ft8",
    modeFamily,
    comment: "Test spot",
    tags,
    receivedAt: observedAt,
  };
}
