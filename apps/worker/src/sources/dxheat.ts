import {
  lookupBand,
  type ParsedSpot,
  type ParsedSpotMode,
  type ParsedSpotModeFamily,
  type SpotTag,
} from "@radio-pilot/shared";

const httpTimeoutMs = 15_000;

type DxHeatRecord = {
  readonly Nr?: string | number;
  readonly DXCall?: string;
  readonly Spotter?: string;
  readonly Flag?: string;
  readonly Frequency?: string;
  readonly Date?: string;
  readonly Time?: string;
  readonly Mode?: string;
  readonly Comment?: string;
};

export async function fetchDxHeatSpots(): Promise<ParsedSpot[]> {
  const url = process.env.DXHEAT_URL?.trim();

  if (!url) {
    console.error("DXHeat fetch skipped: DXHEAT_URL is required");
    return [];
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(httpTimeoutMs) });

    if (!response.ok) {
      console.error(`DXHeat fetch failed: HTTP ${response.status} ${response.statusText}`);
      return [];
    }

    return parseDxHeatPayload((await response.json()) as unknown);
  } catch (error) {
    console.error("DXHeat fetch failed", error);
    return [];
  }
}

export function parseDxHeatPayload(payload: unknown): ParsedSpot[] {
  return Array.isArray(payload) ? payload.flatMap(parseRecordValue) : [];
}

export function parseDxHeatRecord(record: DxHeatRecord): ParsedSpot | null {
  if (!hasRequiredFields(record)) {
    return null;
  }

  const observedAt = parseObservedAt(record.Date, record.Time);
  const frequencyHz = parseFrequencyHz(record.Frequency);

  if (!observedAt || frequencyHz === null) {
    return null;
  }

  const frequencyKHz = frequencyHz / 1000;
  const comment = record.Comment?.trim() ?? "";
  const spottedCallsign = record.DXCall.trim().toUpperCase();
  const spotterCallsign = record.Spotter?.trim().toUpperCase() || "DXHEAT";
  const mode = normalizeMode(record.Mode, comment);

  return {
    id: String(record.Nr),
    source: "dxheat",
    spotterCallsign,
    spottedCallsign,
    countryCode: normalizeCountryCode(record.Flag),
    frequencyKHz,
    frequencyHz,
    band: lookupBand(frequencyKHz),
    observedAt,
    mode: mode.mode,
    modeFamily: mode.modeFamily,
    comment,
    tags: detectTags(comment, spottedCallsign),
  };
}

function parseRecordValue(value: unknown): ParsedSpot[] {
  return isDxHeatRecord(value) ? [parseDxHeatRecord(value)].flatMap(toArray) : [];
}

function hasRequiredFields(record: DxHeatRecord): record is DxHeatRecord & {
  readonly Nr: string | number;
  readonly DXCall: string;
  readonly Frequency: string;
  readonly Date: string;
  readonly Time: string;
} {
  return (
    record.Nr !== undefined &&
    typeof record.DXCall === "string" &&
    record.DXCall.trim().length > 0 &&
    typeof record.Frequency === "string" &&
    record.Frequency.trim().length > 0 &&
    typeof record.Date === "string" &&
    record.Date.trim().length > 0 &&
    typeof record.Time === "string" &&
    record.Time.trim().length > 0
  );
}

function parseObservedAt(dateText: string, timeText: string): string | null {
  const dateMatch = dateText.trim().match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  const timeMatch = timeText.trim().match(/^(\d{2}):?(\d{2})(?::?(\d{2}))?$/);

  if (!dateMatch || !timeMatch) {
    return null;
  }

  const [, dayText, monthText, yearText] = dateMatch;
  const [, hoursText, minutesText, secondsText = "00"] = timeMatch;
  const year = 2000 + Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hours = Number.parseInt(hoursText, 10);
  const minutes = Number.parseInt(minutesText, 10);
  const seconds = Number.parseInt(secondsText, 10);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds)).toISOString();
}

function parseFrequencyHz(frequencyText: string): number | null {
  const normalized = frequencyText.trim().replace(",", ".");
  const frequencyKHz = Number.parseFloat(normalized);

  if (!Number.isFinite(frequencyKHz)) {
    return null;
  }

  return Math.round(frequencyKHz * 1000);
}

function normalizeCountryCode(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMode(
  modeText: string | undefined,
  comment: string,
): { mode: ParsedSpotMode; modeFamily: ParsedSpotModeFamily } {
  const mode = modeText?.trim().toUpperCase();
  const commentUpper = comment.toUpperCase();

  if (mode === "CW") {
    return { mode: "cw", modeFamily: "cw" };
  }

  if (
    mode === "USB" ||
    mode === "LSB" ||
    mode === "PHONE" ||
    mode === "SSB"
  ) {
    return { mode: "ssb", modeFamily: "phone" };
  }

  if (mode === "FT8" || (mode === "DIGITAL" && commentUpper.includes("FT8"))) {
    return { mode: "ft8", modeFamily: "digital" };
  }

  if (mode === "FT4" || (mode === "DIGITAL" && commentUpper.includes("FT4"))) {
    return { mode: "ft4", modeFamily: "digital" };
  }

  if (mode === "DIGITAL") {
    return { mode: "digital", modeFamily: "digital" };
  }

  return { mode: "unknown", modeFamily: "unknown" };
}

function detectTags(comment: string, callsign: string): readonly SpotTag[] {
  const tags: SpotTag[] = [];
  const text = `${comment} ${callsign}`.toUpperCase();

  if (text.includes("SOTA")) {
    tags.push("SOTA");
  }

  if (text.includes("POTA")) {
    tags.push("POTA");
  }

  if (text.includes("WWFF")) {
    tags.push("WWFF");
  }

  if (callsign.includes("/P")) {
    tags.push("/P");
  }

  if (text.includes("FT8")) {
    tags.push("FT8");
  }

  if (text.includes("FT4")) {
    tags.push("FT4");
  }

  return tags;
}

function isDxHeatRecord(value: unknown): value is DxHeatRecord {
  return typeof value === "object" && value !== null;
}

function toArray<T>(value: T | null): T[] {
  return value ? [value] : [];
}
