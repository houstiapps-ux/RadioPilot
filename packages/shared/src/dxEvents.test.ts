import assert from "node:assert/strict";
import test from "node:test";

import { detectDxEvents } from "./dxEvents.js";
import type { ParsedSpot } from "./types.js";

test("detects rare high-interest DX activity from recent spots", async () => {
  const now = Date.now();
  const observedAt = new Date(now - 2 * 60_000).toISOString();
  const spots: ParsedSpot[] = [
    createSpot("FT4GL", "K1AAA", "17m", observedAt),
    createSpot("FT4GL", "DL1BBB", "17m", observedAt),
    createSpot("FT4GL", "JA1CCC", "20m", observedAt),
    createSpot("FT4GL", "EI2DDD", "20m", observedAt),
    createSpot("FT4GL", "F4EEE", "17m", observedAt),
  ];

  const events = await detectDxEvents(spots, {
    async hGet() {
      return null;
    },
    async hmGet(_key: string, fields: string[]) {
      return fields.map(() => null);
    },
    async hIncrBy() {
      return 0;
    },
    async expire() {
      return 1;
    },
  }, now);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.callsign, "FT4GL");
  assert.ok(events[0]?.signals.includes("Rare DX active"));
  assert.ok(events[0]?.signals.includes("High spotter interest"));
  assert.ok(events[0]?.signals.includes("Multi-band DX activity"));
});

function createSpot(
  callsign: string,
  spotter: string,
  band: NonNullable<ParsedSpot["band"]>,
  observedAt: string,
): ParsedSpot {
  return {
    id: `${callsign}:${spotter}:${band}`,
    source: "dxheat",
    spotterCallsign: spotter,
    spottedCallsign: callsign,
    countryCode: "FR",
    continentDx: "AF",
    frequencyKHz: band === "17m" ? 18095 : 14074,
    band,
    observedAt,
    mode: "ft8",
    modeFamily: "digital",
    comment: "CQ",
    tags: ["FT8"],
  };
}
