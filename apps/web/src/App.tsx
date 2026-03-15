import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildOpportunityRequestQuery,
  loadOperatorSettings,
  saveHomeGrid,
  type OperatorSettings,
} from "./settings";

type OpportunityCard = {
  id: string;
  callsign: string;
  band: string | null;
  frequencyKHz: number;
  summary: string;
  countryCode?: string;
  tags: readonly string[];
  score: number;
  direction?: string;
  bearing?: number;
  region?: string;
  confidence?: "Low" | "Medium" | "High";
};

type OpportunitySnapshot = {
  generatedAt: string;
  cards: readonly OpportunityCard[];
  bestOpportunity: OpportunityCard | null;
  watchNext: readonly OpportunityCard[];
  dxOpportunity: OpportunityCard | null;
  nearbyActivity: readonly OpportunityCard[];
};

type SolarData = {
  sfi: string;
  kp: string;
  aIndex: string;
  muf: string;
};

type LoadState = "loading" | "success" | "error";
type PanelTone = "best" | "watch" | "dx" | "nearby";

const opportunitiesUrl = "http://localhost:3000/api/opportunities";
const solarUrl = "https://www.hamqsl.com/solarxml.php";
const opportunityPollIntervalMs = 30_000;
const solarPollIntervalMs = 10 * 60 * 1000;
const portableTags = new Set(["SOTA", "POTA", "WWFF", "/P"]);
const modeTags = new Set(["CW", "SSB", "FT8", "FT4"]);
const countryDisplayNames = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["en"], { type: "region" })
  : null;
const frequencyFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function App() {
  const [snapshot, setSnapshot] = useState<OpportunitySnapshot | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [settings, setSettings] = useState(loadOperatorSettings);
  const [solarData, setSolarData] = useState<SolarData | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | undefined;

    async function loadSnapshot() {
      try {
        const query = buildOpportunityRequestQuery(settings);
        const requestUrl = query.size > 0
          ? `${opportunitiesUrl}?${query.toString()}`
          : opportunitiesUrl;
        const response = await fetch(requestUrl);

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const data = (await response.json()) as OpportunitySnapshot;

        if (!cancelled) {
          setSnapshot(data);
          setLoadState("success");
        }
      } catch {
        if (!cancelled) {
          setLoadState("error");
        }
      }
    }

    void loadSnapshot();
    intervalId = window.setInterval(() => {
      void loadSnapshot();
    }, opportunityPollIntervalMs);

    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | undefined;

    async function loadSolarData() {
      try {
        const response = await fetch(solarUrl);

        if (!response.ok) {
          throw new Error(`Solar request failed with status ${response.status}`);
        }

        const xml = await response.text();
        const parsed = parseSolarData(xml);

        if (!cancelled) {
          setSolarData(parsed);
        }
      } catch {
        if (!cancelled) {
          setSolarData(null);
        }
      }
    }

    void loadSolarData();
    intervalId = window.setInterval(() => {
      void loadSolarData();
    }, solarPollIntervalMs);

    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, []);

  const stationLine = useMemo(() => formatStationLine(settings), [settings]);

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="brand-mark">Radio Pilot</p>
          <h1>Radio Pilot</h1>
        </div>
        <button
          type="button"
          className="settings-toggle"
          aria-label="Open station settings"
          onClick={() => {
            setSettingsOpen((current) => !current);
            window.setTimeout(() => {
              settingsInputRef.current?.focus();
            }, 0);
          }}
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </header>

      <section className="top-strip">
        <div className="station-bar">
          <div>
            <span className="strip-label">Station</span>
            <div className="station-line">{stationLine}</div>
          </div>
          <StatusPill state={loadState} />
        </div>

        <div className="solar-card">
          <SolarPanel data={solarData} />
        </div>
      </section>

      {settingsOpen ? (
        <SettingsPanel
          homeGrid={settings.homeGrid}
          homeContinent={settings.homeContinent}
          homeLatitude={settings.homeLatitude}
          homeLongitude={settings.homeLongitude}
          homeGridValid={settings.homeGridValid}
          inputRef={settingsInputRef}
          onHomeGridChange={(value) => {
            setSettings(saveHomeGrid(value));
          }}
        />
      ) : null}

      <div className="timestamp-row">Last updated: {formatLastUpdated(snapshot?.generatedAt)}</div>

      <section className="panel-grid">
        <div className="panel-column">
          <OpportunityPanel
            title="Best Opportunity"
            tone="best"
            item={snapshot?.bestOpportunity ?? null}
            emptyMessage="No clear top recommendation right now."
            featured
          />

          <OpportunityPanel
            title="DX Opportunity"
            tone="dx"
            item={snapshot?.dxOpportunity ?? null}
            emptyMessage="No standout DX target at the moment."
          />
        </div>

        <div className="panel-column">
          <OpportunityPanel
            title="Watch Next"
            tone="watch"
            items={snapshot?.watchNext ?? []}
            emptyMessage="No follow-on band is building yet."
          />

          <OpportunityPanel
            title="Nearby Activity"
            tone="nearby"
            items={snapshot?.nearbyActivity ?? []}
            emptyMessage="No portable activity is standing out nearby."
          />
        </div>
      </section>
    </main>
  );
}

function SettingsPanel(props: {
  homeGrid: string;
  homeContinent?: string;
  homeLatitude?: number;
  homeLongitude?: number;
  homeGridValid: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onHomeGridChange: (value: string) => void;
}) {
  const showValidation = props.homeGrid.length > 0 && !props.homeGridValid;
  const showSummary = props.homeGridValid;

  return (
    <section className="settings-panel">
      <label className="settings-field">
        <span className="strip-label">Home grid</span>
        <input
          ref={props.inputRef}
          className="settings-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="IO63UI"
          value={props.homeGrid}
          onChange={(event) => {
            props.onHomeGridChange(event.target.value);
          }}
        />
      </label>

      {showValidation ? (
        <div className="settings-validation">
          Enter a valid Maidenhead locator, for example `IO63UI`.
        </div>
      ) : null}

      {showSummary ? (
        <div className="settings-summary">
          <div className="summary-block">
            <span className="strip-label">Derived home continent</span>
            <div className="summary-value">
              {props.homeContinent ? props.homeContinent : "Unavailable"}
            </div>
          </div>
          <div className="summary-block">
            <span className="strip-label">Approximate lat/lon</span>
            <div className="summary-value">
              {formatCoordinatePair(props.homeLatitude, props.homeLongitude)}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StatusPill(props: { state: LoadState }) {
  const className =
    props.state === "success"
      ? "status-pill status-ok"
      : props.state === "error"
        ? "status-pill status-bad"
        : "status-pill status-wait";
  const label =
    props.state === "success"
      ? "Live data loaded"
      : props.state === "error"
        ? "Connection issue"
        : "Loading";

  return <div className={className}>{label}</div>;
}

function SolarPanel(props: { data: SolarData | null }) {
  return (
    <>
      <div className="solar-card-header">
        <div>
          <span className="strip-label">Solar</span>
          <div className="solar-title">Propagation instruments</div>
        </div>
        <div className="solar-status">
          {props.data ? "Live solar data" : "Calm placeholder"}
        </div>
      </div>

      <div className="solar-panel">
        <GaugeMetric
          label="SFI"
          value={props.data?.sfi}
          min={60}
          max={220}
          bands={[
            { stop: 0.28, className: "gauge-band-weak" },
            { stop: 0.62, className: "gauge-band-fair" },
            { stop: 1, className: "gauge-band-strong" },
          ]}
          rangeLabel="Weak to strong"
          idleLabel="No flux data"
        />

        <GaugeMetric
          label="Kp"
          value={props.data?.kp}
          min={0}
          max={9}
          bands={[
            { stop: 0.34, className: "gauge-band-quiet" },
            { stop: 0.67, className: "gauge-band-restless" },
            { stop: 1, className: "gauge-band-disturbed" },
          ]}
          rangeLabel="Quiet to disturbed"
          idleLabel="No Kp data"
        />

        <SolarReading
          label="A-index"
          value={props.data?.aIndex ?? "No data"}
          hint={props.data ? "Geomagnetic background" : "Awaiting feed"}
        />

        <SolarReading
          label="MUF"
          value={props.data?.muf ?? "No data"}
          hint={props.data ? "Estimated upper usable freq" : "Awaiting feed"}
        />
      </div>
    </>
  );
}

function GaugeMetric(props: {
  label: string;
  value: string | undefined;
  min: number;
  max: number;
  bands: readonly { stop: number; className: string }[];
  rangeLabel: string;
  idleLabel: string;
}) {
  const numericValue = parseSolarNumber(props.value);
  const hasValue = numericValue !== null;
  const ratio = hasValue
    ? clamp((numericValue - props.min) / (props.max - props.min), 0, 1)
    : 0;
  const angle = -120 + ratio * 240;

  return (
    <div className={`solar-gauge ${hasValue ? "" : "solar-gauge-idle"}`}>
      <div className="solar-gauge-head">
        <span className="solar-gauge-label">{props.label}</span>
        <span className="solar-gauge-scale">{props.rangeLabel}</span>
      </div>

      <svg className="solar-gauge-svg" viewBox="0 0 160 112" aria-hidden="true">
        {props.bands.map((band, index) => {
          const startRatio = index === 0 ? 0 : props.bands[index - 1]?.stop ?? 0;
          return (
            <path
              key={`${props.label}-${band.className}`}
              className={`solar-gauge-arc ${band.className}`}
              d={describeArcSegment(80, 86, 50, -120 + startRatio * 240, -120 + band.stop * 240)}
            />
          );
        })}
        <g
          className="solar-gauge-pointer"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <line x1="80" y1="86" x2="80" y2="36" />
        </g>
        <circle className="solar-gauge-cap" cx="80" cy="86" r="4.5" />
      </svg>

      <div className="solar-gauge-value">
        {hasValue ? formatSolarNumber(numericValue) : "No data"}
      </div>
      <div className="solar-gauge-status">
        {hasValue ? props.rangeLabel : props.idleLabel}
      </div>
    </div>
  );
}

function SolarReading(props: { label: string; value: string; hint: string }) {
  return (
    <div className="solar-reading">
      <span className="solar-reading-label">{props.label}</span>
      <span className="solar-reading-value">{props.value}</span>
      <span className="solar-reading-hint">{props.hint}</span>
    </div>
  );
}

function OpportunityPanel(props: {
  title: string;
  tone: PanelTone;
  item?: OpportunityCard | null;
  items?: readonly OpportunityCard[];
  emptyMessage: string;
  featured?: boolean;
}) {
  const cards = props.item ? [props.item] : props.items ?? [];

  return (
    <section className={`opportunity-panel tone-${props.tone} ${props.featured ? "panel-featured" : ""}`}>
      <div className="panel-title">{props.title}</div>
      {cards.length === 0 ? (
        <div className="panel-empty">{props.emptyMessage}</div>
      ) : (
        <div className="panel-items">
          {cards.map((card) => (
            <OperatorCard
              key={card.id}
              card={card}
              tone={props.tone}
              featured={props.featured}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function OperatorCard(props: {
  card: OpportunityCard;
  tone: PanelTone;
  featured?: boolean;
}) {
  const view = toOperatorView(props.card, props.tone);

  return (
    <article className={`operator-card ${props.featured ? "operator-card-featured" : ""}`}>
      <div className="operator-row">
        <div>
          <div className="operator-band">{view.band}</div>
          <div className="operator-target">{view.primaryLine}</div>
        </div>
        <div className="operator-frequency">{formatFrequency(props.card.frequencyKHz)}</div>
      </div>

      <div className="operator-meta-grid">
        <MetaLine label="Country" value={view.country} />
        <MetaLine label="Direction" value={view.directionLine} />
        <MetaLine label="Beam" value={view.beamHeading} />
        <MetaLine label="Modes" value={view.suggestedModes} />
        <MetaLine label="Confidence" value={view.confidence} />
      </div>

      <p className="operator-reason">{view.reasonSummary}</p>

      <div className="tag-strip">
        {view.tagItems.length > 0 ? (
          view.tagItems.map((tag) => (
            <span
              key={tag}
              className={portableTags.has(tag) ? "tag-chip tag-chip-portable" : "tag-chip"}
            >
              {tag}
            </span>
          ))
        ) : (
          <span className="tag-chip tag-chip-muted">None</span>
        )}
      </div>
    </article>
  );
}

function MetaLine(props: { label: string; value: string }) {
  return (
    <div className="meta-line">
      <span className="meta-line-label">{props.label}</span>
      <span className="meta-line-value">{props.value}</span>
    </div>
  );
}

function toOperatorView(card: OpportunityCard, tone: PanelTone): {
  band: string;
  primaryLine: string;
  country: string;
  directionLine: string;
  beamHeading: string;
  suggestedModes: string;
  confidence: string;
  reasonSummary: string;
  tagItems: readonly string[];
} {
  const direction = extractDirection(card.summary);
  const heading = direction ? `${direction.degrees}°` : "Unavailable";
  const suggestedModes = getSuggestedModes(card);
  const confidence = getConfidence(card.score);

  if (tone === "watch") {
    return {
      band: safeText(card.band, "Unknown band"),
      primaryLine: direction ? `Toward ${direction.label}` : safeText(card.callsign, "Activity rising"),
      country: formatCountry(card.countryCode),
      directionLine: direction ? direction.label : "Trend building",
      beamHeading: heading,
      suggestedModes,
      confidence,
      reasonSummary: safeText(card.summary, "Activity is rising."),
      tagItems: card.tags,
    };
  }

  if (tone === "dx") {
    return {
      band: safeText(card.band, "Unknown band"),
      primaryLine: safeText(card.callsign, "DX target"),
      country: formatCountry(card.countryCode),
      directionLine: direction ? direction.label : "Direction unavailable",
      beamHeading: heading,
      suggestedModes,
      confidence,
      reasonSummary: safeText(card.summary, "Distant DX is showing."),
      tagItems: card.tags,
    };
  }

  if (tone === "nearby") {
    return {
      band: safeText(card.band, "Unknown band"),
      primaryLine: safeText(card.callsign, "Portable activity"),
      country: formatCountry(card.countryCode),
      directionLine: direction ? direction.label : "Nearby path unavailable",
      beamHeading: heading,
      suggestedModes,
      confidence,
      reasonSummary: safeText(card.summary, "Portable activity is active."),
      tagItems: card.tags,
    };
  }

  return {
    band: safeText(card.band, "Unknown band"),
    primaryLine: direction ? `${direction.label} (${heading})` : safeText(card.callsign, "Best path"),
    country: formatCountry(card.countryCode),
    directionLine: direction ? direction.label : "Direction unavailable",
    beamHeading: heading,
    suggestedModes,
    confidence,
    reasonSummary: safeText(card.summary, "Best current opening."),
    tagItems: card.tags,
  };
}

function getSuggestedModes(card: OpportunityCard): string {
  const modes = card.tags.filter((tag) => modeTags.has(tag));

  if (modes.length > 0) {
    return modes.join(" / ");
  }

  const summary = card.summary.toUpperCase();

  if (summary.includes("DIGITAL")) {
    return "Digital likely";
  }

  if (summary.includes("PHONE")) {
    return "Voice likely";
  }

  if (summary.includes("CW")) {
    return "CW likely";
  }

  return "Mixed modes";
}

function getConfidence(score: number): string {
  if (score >= 400) {
    return "High";
  }

  if (score >= 200) {
    return "Medium";
  }

  return "Low";
}

function extractDirection(summary: string): { label: string; degrees: number } | null {
  const match = summary.match(/\b(N|NE|E|SE|S|SW|W|NW)\b/i);

  if (!match) {
    return null;
  }

  const direction = match[1].toUpperCase() as keyof typeof directionMap;
  return directionMap[direction];
}

function formatStationLine(settings: OperatorSettings): string {
  const grid = settings.homeGridValid ? settings.homeGrid.slice(0, 4) : "Not set";
  return `Location: ${grid} | HF/VHF`;
}

function parseSolarData(xml: string): SolarData {
  const document = new DOMParser().parseFromString(xml, "text/xml");

  return {
    sfi: readSolarValue(document, ["solarflux", "solarfluxindex", "sfi"]),
    kp: readSolarValue(document, ["kindex", "kp"]),
    aIndex: readSolarValue(document, ["aindex", "a-index", "aindexindex"]),
    muf: readSolarValue(document, ["muf"]),
  };
}

function readSolarValue(document: Document, tags: readonly string[]): string {
  for (const tag of tags) {
    const value = document.querySelector(tag)?.textContent?.trim();
    if (value) {
      return value;
    }
  }

  return "No data";
}

function parseSolarNumber(value: string | undefined): number | null {
  if (!value || value === "No data") {
    return null;
  }

  const numericValue = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(numericValue) ? numericValue : null;
}

function formatSolarNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleDegrees: number,
): { x: number; y: number } {
  const angleRadians = ((angleDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleRadians),
    y: centerY + radius * Math.sin(angleRadians),
  };
}

function describeArcSegment(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(centerX, centerY, radius, endAngle);
  const end = polarToCartesian(centerX, centerY, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

function formatFrequency(value: number): string {
  return `${frequencyFormatter.format(value)} kHz`;
}

function formatLastUpdated(value: string | undefined): string {
  if (!value) {
    return "Waiting for data";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Waiting for data";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatCoordinatePair(
  latitude: number | undefined,
  longitude: number | undefined,
): string {
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return "Unavailable";
  }

  return `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;
}

function safeText(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function formatCountry(countryCode: string | undefined): string {
  if (!countryCode) {
    return "Unavailable";
  }

  try {
    const label = countryDisplayNames?.of(countryCode.toUpperCase());
    return label && label.trim().length > 0 ? label : countryCode.toUpperCase();
  } catch {
    return countryCode.toUpperCase();
  }
}

const directionMap = {
  N: { label: "North", degrees: 0 },
  NE: { label: "North-East", degrees: 45 },
  E: { label: "East", degrees: 90 },
  SE: { label: "South-East", degrees: 135 },
  S: { label: "South", degrees: 180 },
  SW: { label: "South-West", degrees: 225 },
  W: { label: "West", degrees: 270 },
  NW: { label: "North-West", degrees: 315 },
} as const;
