import type { SolarConditions } from "@radio-pilot/shared";

const httpTimeoutMs = 15_000;
const defaultSolarUrl = "https://www.hamqsl.com/solarxml.php";

export async function fetchSolarConditions(): Promise<SolarConditions | null> {
  const url = process.env.SOLAR_URL?.trim() || defaultSolarUrl;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(httpTimeoutMs) });

    if (!response.ok) {
      console.error(`Solar fetch failed: HTTP ${response.status} ${response.statusText}`);
      return null;
    }

    const xml = await response.text();
    return parseSolarXml(xml, new Date().toISOString());
  } catch (error) {
    console.error("Solar fetch failed", error);
    return null;
  }
}

export function parseSolarXml(xml: string, fetchedAt: string): SolarConditions | null {
  const sfi = readXmlValue(xml, ["solarflux", "solarfluxindex", "sfi"]);
  const kp = readXmlValue(xml, ["kindex", "kp"]);

  if (!sfi || !kp) {
    return null;
  }

  return {
    sfi,
    kp,
    aIndex: readXmlValue(xml, ["aindex", "a-index", "a"]),
    muf: readXmlValue(xml, ["muf", "calculatedmuf"]),
    updatedAt: readUpdatedAt(xml) ?? fetchedAt,
  };
}

function readUpdatedAt(xml: string): string | undefined {
  const sourceDate = readXmlValue(xml, ["source", "updated", "timestamp"]);

  if (!sourceDate) {
    return undefined;
  }

  const parsed = Date.parse(sourceDate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : sourceDate;
}

function readXmlValue(xml: string, tagNames: readonly string[]): string | undefined {
  for (const tagName of tagNames) {
    const pattern = new RegExp(`<${tagName}>([^<]+)</${tagName}>`, "i");
    const match = xml.match(pattern);
    const value = match?.[1]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}
