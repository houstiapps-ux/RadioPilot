import assert from "node:assert/strict";
import test from "node:test";

import { parseSolarXml } from "./solar.js";

test("parses core solar values from xml", () => {
  const parsed = parseSolarXml(
    `
      <solar>
        <solarflux>154</solarflux>
        <kindex>2</kindex>
        <aindex>7</aindex>
        <muf>32.1</muf>
        <sunspots>88</sunspots>
        <updated>2026-03-15T10:00:00Z</updated>
      </solar>
    `,
    "2026-03-15T10:05:00.000Z",
  );

  assert.deepEqual(parsed, {
    sfi: 154,
    kp: 2,
    aIndex: 7,
    muf: 32.1,
    sunspots: 88,
    updatedAt: "2026-03-15T10:00:00.000Z",
  });
});

test("falls back to fetched time when source update is unavailable", () => {
  const parsed = parseSolarXml(
    `
      <solar>
        <solarfluxindex>101</solarfluxindex>
        <kp>4</kp>
      </solar>
    `,
    "2026-03-15T10:05:00.000Z",
  );

  assert.deepEqual(parsed, {
    sfi: 101,
    kp: 4,
    aIndex: undefined,
    muf: undefined,
    sunspots: undefined,
    updatedAt: "2026-03-15T10:05:00.000Z",
  });
});

test("does not use unrelated source text as updatedAt", () => {
  const parsed = parseSolarXml(
    `
      <solar>
        <source>N0NBH</source>
        <solarflux>133</solarflux>
        <kindex>3</kindex>
      </solar>
    `,
    "2026-03-15T10:05:00.000Z",
  );

  assert.deepEqual(parsed, {
    sfi: 133,
    kp: 3,
    aIndex: undefined,
    muf: undefined,
    sunspots: undefined,
    updatedAt: "2026-03-15T10:05:00.000Z",
  });
});

test("parses MUF numeric values from text with units", () => {
  const parsed = parseSolarXml(
    `
      <solar>
        <solarflux>145</solarflux>
        <kindex>2</kindex>
        <calculatedmuf>32.4 MHz</calculatedmuf>
      </solar>
    `,
    "2026-03-15T10:05:00.000Z",
  );

  assert.deepEqual(parsed, {
    sfi: 145,
    kp: 2,
    aIndex: undefined,
    muf: 32.4,
    sunspots: undefined,
    updatedAt: "2026-03-15T10:05:00.000Z",
  });
});
