import {
  deriveContinentFromMaidenhead,
  maidenheadToLatLon,
  parseMaidenheadLocator,
} from "@radio-pilot/shared";

export interface OperatorSettings {
  readonly homeGrid: string;
  readonly homeContinent?: string;
  readonly operatingStyle?: string;
  readonly chasing?: "any" | "dx" | "pota" | "sota" | "portable" | "digital";
  readonly modeFilter?: "any" | "ssb" | "cw" | "digital";
  readonly bandScope?: "any" | "hf" | "vhf-uhf";
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
    chasing: normalizeChasingSetting(stored.chasing),
    modeFilter: normalizeModeFilterSetting(stored.modeFilter),
    bandScope: normalizeBandScopeSetting(stored.bandScope),
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
    chasing: normalizeChasingSetting(stored.chasing),
    modeFilter: normalizeModeFilterSetting(stored.modeFilter),
    bandScope: normalizeBandScopeSetting(stored.bandScope),
    homeContinent: stationSummary.homeContinent,
    homeLatitude: stationSummary.homeLatitude,
    homeLongitude: stationSummary.homeLongitude,
    homeGridValid: stationSummary.homeGridValid,
  };
}

export function saveOperatorIntent(
  updates: Partial<Pick<OperatorSettings, "chasing" | "modeFilter" | "bandScope">>,
): OperatorSettings {
  const stored = readStoredSettings();
  const homeGrid = normalizeGridValue(stored.homeGrid);
  const stationSummary = getStationSummary(homeGrid);
  const nextStored: Record<string, unknown> = {
    ...stored,
    chasing: updates.chasing ?? stored.chasing,
    modeFilter: updates.modeFilter ?? stored.modeFilter,
    bandScope: updates.bandScope ?? stored.bandScope,
  };

  window.localStorage.setItem(storageKey, JSON.stringify(nextStored));

  return {
    homeGrid,
    operatingStyle: normalizeOptionalSetting(stored.operatingStyle),
    chasing: normalizeChasingSetting(nextStored.chasing),
    modeFilter: normalizeModeFilterSetting(nextStored.modeFilter),
    bandScope: normalizeBandScopeSetting(nextStored.bandScope),
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

  if (settings.chasing && settings.chasing !== "any") {
    params.set("chasing", settings.chasing);
  }

  if (settings.modeFilter && settings.modeFilter !== "any") {
    params.set("mode", settings.modeFilter);
  }

  if (settings.bandScope && settings.bandScope !== "any") {
    params.set("bandScope", settings.bandScope);
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

function normalizeChasingSetting(
  value: unknown,
): OperatorSettings["chasing"] {
  if (typeof value !== "string") {
    return "any";
  }

  switch (value.trim().toLowerCase()) {
    case "dx":
    case "pota":
    case "sota":
    case "portable":
    case "digital":
      return value.trim().toLowerCase() as Exclude<OperatorSettings["chasing"], "any" | undefined>;
    default:
      return "any";
  }
}

function normalizeModeFilterSetting(
  value: unknown,
): OperatorSettings["modeFilter"] {
  if (typeof value !== "string") {
    return "any";
  }

  switch (value.trim().toLowerCase()) {
    case "ssb":
    case "cw":
    case "digital":
      return value.trim().toLowerCase() as Exclude<OperatorSettings["modeFilter"], "any" | undefined>;
    default:
      return "any";
  }
}

function normalizeBandScopeSetting(
  value: unknown,
): OperatorSettings["bandScope"] {
  if (typeof value !== "string") {
    return "any";
  }

  switch (value.trim().toLowerCase()) {
    case "hf":
    case "vhf-uhf":
      return value.trim().toLowerCase() as Exclude<OperatorSettings["bandScope"], "any" | undefined>;
    default:
      return "any";
  }
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
