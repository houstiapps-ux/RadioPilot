import {
  deriveContinentFromMaidenhead,
  maidenheadToLatLon,
  parseMaidenheadLocator,
} from "@radio-pilot/shared";

export interface OperatorSettings {
  readonly homeGrid: string;
  readonly homeContinent?: string;
  readonly operatingStyle?: string;
  readonly homeLatitude?: number;
  readonly homeLongitude?: number;
  readonly homeGridValid: boolean;
}

const storageKey = "radio-pilot.settings";

export function loadOperatorSettings(): OperatorSettings {
  const stored = readStoredSettings();
  const homeGrid = normalizeGridValue(stored.homeGrid);
  const operatingStyle = normalizeOptionalSetting(stored.operatingStyle);
  const stationSummary = getStationSummary(homeGrid);

  return {
    homeGrid,
    operatingStyle,
    homeContinent: stationSummary.homeContinent,
    homeLatitude: stationSummary.homeLatitude,
    homeLongitude: stationSummary.homeLongitude,
    homeGridValid: stationSummary.homeGridValid,
  };
}

export function saveHomeGrid(homeGrid: string): OperatorSettings {
  const stored = readStoredSettings();
  const normalizedHomeGrid = normalizeGridValue(homeGrid);
  const stationSummary = getStationSummary(normalizedHomeGrid);
  const nextStored: Record<string, unknown> = {
    ...stored,
    homeGrid: normalizedHomeGrid,
  };

  delete nextStored.homeContinent;

  window.localStorage.setItem(storageKey, JSON.stringify(nextStored));

  return {
    homeGrid: normalizedHomeGrid,
    operatingStyle: normalizeOptionalSetting(stored.operatingStyle),
    homeContinent: stationSummary.homeContinent,
    homeLatitude: stationSummary.homeLatitude,
    homeLongitude: stationSummary.homeLongitude,
    homeGridValid: stationSummary.homeGridValid,
  };
}

export function buildOpportunityRequestQuery(settings: OperatorSettings): URLSearchParams {
  const params = new URLSearchParams();

  if (settings.homeGrid.length > 0) {
    params.set("homeGrid", settings.homeGrid);
  }

  if (settings.operatingStyle) {
    params.set("operatingStyle", settings.operatingStyle);
  }

  return params;
}

function getStationSummary(homeGrid: string): Pick<
  OperatorSettings,
  "homeContinent" | "homeLatitude" | "homeLongitude" | "homeGridValid"
> {
  if (homeGrid.length === 0) {
    return {
      homeContinent: undefined,
      homeLatitude: undefined,
      homeLongitude: undefined,
      homeGridValid: false,
    };
  }

  if (!parseMaidenheadLocator(homeGrid)) {
    return {
      homeContinent: undefined,
      homeLatitude: undefined,
      homeLongitude: undefined,
      homeGridValid: false,
    };
  }

  const coordinates = maidenheadToLatLon(homeGrid);

  return {
    homeContinent: deriveContinentFromMaidenhead(homeGrid),
    homeLatitude: coordinates?.latitude,
    homeLongitude: coordinates?.longitude,
    homeGridValid: true,
  };
}

function normalizeGridValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeOptionalSetting(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStoredSettings(): Record<string, unknown> {
  try {
    const rawValue = window.localStorage.getItem(storageKey);

    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as unknown;
    return typeof parsed === "object" && parsed !== null ? { ...parsed as Record<string, unknown> } : {};
  } catch {
    return {};
  }
}
