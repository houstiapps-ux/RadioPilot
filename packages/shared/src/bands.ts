const BAND_RANGES = [
  { band: "160m", min: 1800, max: 2000 },
  { band: "80m", min: 3500, max: 4000 },
  { band: "60m", min: 5330.5, max: 5406.5 },
  { band: "40m", min: 7000, max: 7300 },
  { band: "30m", min: 10100, max: 10150 },
  { band: "20m", min: 14000, max: 14350 },
  { band: "17m", min: 18068, max: 18168 },
  { band: "15m", min: 21000, max: 21450 },
  { band: "12m", min: 24890, max: 24990 },
  { band: "10m", min: 28000, max: 29700 },
  { band: "6m", min: 50000, max: 54000 },
  { band: "2m", min: 144000, max: 148000 },
] as const;

export type Band = (typeof BAND_RANGES)[number]["band"];

export function lookupBand(frequencyKHz: number): Band | null {
  for (const range of BAND_RANGES) {
    if (frequencyKHz >= range.min && frequencyKHz <= range.max) {
      return range.band;
    }
  }

  return null;
}
