import { lookupBand } from "./bands.js";
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

  return {
    spotterCallsign: spotterCallsign.toUpperCase(),
    spottedCallsign: spottedCallsign.toUpperCase(),
    frequencyKHz,
    band: lookupBand(frequencyKHz),
    comment,
    tags: detectTags(comment),
  };
}

function detectTags(comment: string): readonly SpotTag[] {
  return TAG_PATTERNS.filter(([, pattern]) => pattern.test(comment)).map(
    ([tag]) => tag,
  );
}
