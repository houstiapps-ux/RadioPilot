import { resolveBand } from "./bands.js";
import type { ParsedSpot, SpotTag } from "./types.js";

const DX_LINE_PATTERN =
  /^DX de\s+([A-Z0-9\/#-]+):?\s+(\d+(?:\.\d+)?)\s+([A-Z0-9\/#-]+)\s*(.*)$/i;

const TAG_PATTERNS: ReadonlyArray<readonly [SpotTag, RegExp]> = [
  ["SOTA", /\bSOTA\b/i],
  ["POTA", /\bPOTA\b/i],
  ["FT8", /\bFT8\b/i],
  ["FT4", /\bFT4\b/i],
  ["CW", /\bCW\b/i],
  ["SSB", /\bSSB\b/i],
];

export function parseDxClusterLine(line: string): ParsedSpot | null {
  const match = line.trim().match(DX_LINE_PATTERN);

  if (!match) {
    return null;
  }

  const [, spotterCallsign, frequencyText, spottedCallsign, trailingText] = match;
  const frequencyKHz = Number.parseFloat(frequencyText);

  if (Number.isNaN(frequencyKHz)) {
    return null;
  }

  const comment = trailingText.trim();
  const normalizedSpotter = spotterCallsign.toUpperCase();
  const normalizedSpotted = spottedCallsign.toUpperCase();

  return {
    id: buildTelnetSpotId(normalizedSpotter, normalizedSpotted, frequencyKHz, comment),
    source: "telnet",
    spotterCallsign: normalizedSpotter,
    spottedCallsign: normalizedSpotted,
    frequencyKHz,
    band: resolveBand(null, frequencyKHz),
    comment,
    tags: detectTags(comment),
  };
}

function buildTelnetSpotId(
  spotterCallsign: string,
  spottedCallsign: string,
  frequencyKHz: number,
  comment: string,
): string {
  return [spotterCallsign, spottedCallsign, frequencyKHz.toFixed(1), comment].join("|");
}

function detectTags(comment: string): readonly SpotTag[] {
  return TAG_PATTERNS.filter(([, pattern]) => pattern.test(comment)).map(
    ([tag]) => tag,
  );
}
