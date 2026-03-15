import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildOpportunityRequestQuery,
  loadOperatorSettings,
  saveHomeGrid,
  saveOperatorIntent,
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
  beamHeading?: number;
  region?: string;
  confidence?: "Low" | "Medium" | "High";
  confidenceReason?: string;
  bandState?: "Opening" | "Stable" | "Fading";
  trendLabel?: "Rising" | "Steady" | "Falling";
  directionConfidence?: "High" | "Medium" | "Low";
  strongestPropagationSignal?: string;
  dxEventType?: string;
  signals?: readonly string[];
  why?: readonly string[];
  actionLine?: string;
};

type SolarData = {
  sfi?: number;
  kp?: number;
  muf?: number | string;
  aIndex?: number;
  sunspots?: number;
  updatedAt?: string;
};

type OpportunitySnapshot = {
  generatedAt: string;
  cards: readonly OpportunityCard[];
  bestOpportunity: OpportunityCard | null;
  watchNext: readonly OpportunityCard[];
  dxOpportunity: OpportunityCard | null;
  nearbyActivity: readonly OpportunityCard[];
  solar?: SolarData | null;
};

type LoadState = "loading" | "success" | "error";
type PanelTone = "best" | "watch" | "dx" | "nearby";

const opportunitiesUrl = "http://localhost:3000/api/opportunities";
const opportunityPollIntervalMs = 30_000;
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

  const stationLine = useMemo(() => formatStationLine(settings), [settings]);
  const solarData = snapshot?.solar ?? null;

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
      </section>

      <section className="intent-bar">
        <FilterGroup
          label="Chasing"
          value={settings.chasing ?? "any"}
          options={[
            { value: "any", label: "Any" },
            { value: "dx", label: "DX" },
            { value: "pota", label: "POTA" },
            { value: "sota", label: "SOTA" },
            { value: "portable", label: "Portable" },
            { value: "digital", label: "Digital" },
          ]}
          onChange={(value) => {
            setSettings(saveOperatorIntent({ chasing: value as OperatorSettings["chasing"] }));
          }}
        />
        <FilterGroup
          label="Mode"
          value={settings.modeFilter ?? "any"}
          options={[
            { value: "any", label: "Any" },
            { value: "ssb", label: "SSB" },
            { value: "cw", label: "CW" },
            { value: "digital", label: "Digital" },
          ]}
          onChange={(value) => {
            setSettings(saveOperatorIntent({ modeFilter: value as OperatorSettings["modeFilter"] }));
          }}
        />
        <FilterGroup
          label="Bands"
          value={settings.bandScope ?? "any"}
          options={[
            { value: "any", label: "Any" },
            { value: "hf", label: "HF" },
            { value: "vhf-uhf", label: "VHF/UHF" },
          ]}
          onChange={(value) => {
            setSettings(saveOperatorIntent({ bandScope: value as OperatorSettings["bandScope"] }));
          }}
        />
      </section>

      <section className="solar-card">
        <SolarPanel data={solarData} />
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

function FilterGroup(props: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="filter-group-card">
      <div className="filter-group">
      <span className="strip-label">{props.label}</span>
      <div className="filter-chip-row">
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`filter-chip ${props.value === option.value ? "filter-chip-active" : ""}`}
            onClick={() => {
              props.onChange(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      </div>
    </div>
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
  const updatedLabel = formatSolarUpdatedAt(props.data?.updatedAt);
  const unavailable = !props.data;

  return (
    <>
      <div className="solar-card-header">
        <div>
          <span className="strip-label">Solar</span>
          <div className="solar-title">Propagation Conditions</div>
        </div>
        {props.data ? <div className="solar-status">Live solar data</div> : null}
      </div>

      <div className="solar-panel">
        <CompactSolarMetric
          label="SFI"
          value={props.data?.sfi}
          min={60}
          max={220}
          bands={[
            { stop: 0.22, className: "metric-band-poor" },
            { stop: 0.46, className: "metric-band-fair" },
            { stop: 0.74, className: "metric-band-good" },
            { stop: 1, className: "metric-band-strong" },
          ]}
          rangeLabel="Poor to strong"
        />

        <CompactSolarMetric
          label="Kp"
          value={props.data?.kp}
          min={0}
          max={9}
          bands={[
            { stop: 0.34, className: "metric-band-quiet" },
            { stop: 0.72, className: "metric-band-disturbed" },
            { stop: 1, className: "metric-band-stormy" },
          ]}
          rangeLabel="Quiet to stormy"
        />

        <CompactSolarReading
          label="MUF"
          value={formatSolarValue(props.data?.muf)}
          hint={props.data ? "Estimated upper usable freq" : ""}
        />
      </div>

      <div className="solar-secondary">
        <span>A-index {formatSolarValue(props.data?.aIndex)}</span>
        <span>Updated {updatedLabel}</span>
        {unavailable ? <span>Solar data unavailable</span> : null}
      </div>
    </>
  );
}

function CompactSolarMetric(props: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  bands: readonly { stop: number; className: string }[];
  rangeLabel: string;
}) {
  const numericValue = parseSolarNumber(props.value);
  const hasValue = numericValue !== null;
  const ratio = hasValue
    ? clamp((numericValue - props.min) / (props.max - props.min), 0, 1)
    : 0;
  const fillWidth = `${Math.max(0, Math.min(100, ratio * 100))}%`;

  return (
    <div className={`solar-metric ${hasValue ? "" : "solar-metric-idle"}`}>
      <div className="solar-metric-head">
        <span className="solar-metric-label">{props.label}</span>
        <span className="solar-metric-value">{hasValue ? formatSolarNumber(numericValue) : "—"}</span>
      </div>
      <div className="solar-meter" aria-hidden="true">
        <div className="solar-meter-bands">
          {props.bands.map((band, index) => {
            const previousStop = index === 0 ? 0 : props.bands[index - 1]?.stop ?? 0;
            return (
              <span
                key={`${props.label}-${band.className}`}
                className={`solar-meter-band ${band.className}`}
                style={{ width: `${(band.stop - previousStop) * 100}%` }}
              />
            );
          })}
        </div>
        <div className="solar-meter-fill" style={{ width: fillWidth }} />
      </div>
      <div className="solar-metric-scale">{props.rangeLabel}</div>
    </div>
  );
}

function CompactSolarReading(props: { label: string; value: string; hint: string }) {
  return (
    <div className="solar-metric solar-reading-compact">
      <div className="solar-metric-head">
        <span className="solar-metric-label">{props.label}</span>
        <span className="solar-metric-value">{props.value}</span>
      </div>
      <div className="solar-metric-scale">{props.hint}</div>
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
  const modeItems = getModeIndicators(props.card);
  const operationItem = getOperationIndicator(props.card.tags);
  const intelligenceChips = getIntelligenceChips(props.card, props.tone);
  const whyItems = getWhyItems(props.card, props.tone);

  return (
    <article className={`operator-card ${props.featured ? "operator-card-featured" : ""}`}>
      <div className="operator-row">
        <div>
          <div className="operator-target-row">
            <CountryFlag countryCode={props.card.countryCode} countryName={view.country} />
            <div className="operator-target">{view.primaryLine}</div>
            {modeItems.length > 0 ? (
              <div className="icon-strip header-icon-strip">
                {modeItems.map((item) => (
                  <span
                    key={item.id}
                    className="header-icon"
                    title={item.label}
                    aria-label={item.label}
                  >
                    {item.glyph}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="operator-subline">{view.country}</div>
        </div>
      </div>

      <div className="operator-stats">
        <StatPill label="Band" value={view.band} />
        <StatPill label="Freq" value={formatFrequency(props.card.frequencyKHz)} />
        <StatPill label="Dir" value={view.directionLine} />
        <StatPill label="Beam" value={view.beamHeading} />
        <ConfidenceMetaLine value={view.confidence} card={props.card} />
      </div>

      <p className="operator-reason">{view.reasonSummary}</p>

      {props.card.actionLine ? (
        <div className={`action-line action-line-${props.tone}`}>{props.card.actionLine}</div>
      ) : null}

      {intelligenceChips.length > 0 ? (
        <div className="intel-strip">
          {intelligenceChips.map((chip) => (
            <span key={chip} className="intel-chip">{chip}</span>
          ))}
        </div>
      ) : null}

      {whyItems.length > 0 ? (
        <div className="evidence-block">
          <span className="operation-label">Why</span>
          <div className="evidence-list">
            {whyItems.map((item) => (
              <span key={item} className="evidence-item">{item}</span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="operation-block">
        <span className="operation-label">Operation</span>
        <div className="tag-strip">
          {operationItem ? (
            operationItem.kind === "icon"
              ? (
                <span
                  key={operationItem.id}
                  className="tag-chip tag-chip-icon"
                  title={operationItem.label}
                  aria-label={operationItem.label}
                >
                  <span className="inline-symbol" aria-hidden="true">{operationItem.glyph}</span>
                  <span>{operationItem.text}</span>
                </span>
              )
              : (
                <span key={operationItem.id} className="tag-chip">
                  {operationItem.text}
                </span>
              )
          ) : (
            <span className="tag-chip tag-chip-muted">Fixed station</span>
          )}
        </div>
      </div>
    </article>
  );
}

function CountryFlag(props: { countryCode?: string; countryName: string }) {
  const normalizedCountryCode = normalizeCountryCode(props.countryCode);

  if (!normalizedCountryCode) {
    return null;
  }

  const emojiFlag = countryCodeToFlagEmoji(normalizedCountryCode);
  const imageUrl = `https://flagcdn.com/w20/${normalizedCountryCode.toLowerCase()}.png`;

  return (
    <span className="operator-flag-wrap" title={props.countryName} aria-label={props.countryName}>
      <img
        className="operator-flag-image"
        src={imageUrl}
        alt=""
        loading="lazy"
        width="20"
        height="15"
      />
      {emojiFlag ? <span className="operator-flag operator-flag-fallback" aria-hidden="true">{emojiFlag}</span> : null}
    </span>
  );
}

function StatPill(props: { label: string; value: string }) {
  return (
    <div className="stat-pill">
      <span className="stat-pill-label">{props.label}</span>
      <span className="stat-pill-value">{props.value}</span>
    </div>
  );
}

function ConfidenceMetaLine(props: { value: string; card: OpportunityCard }) {
  const toneClassName =
    props.value === "High"
      ? "confidence-badge confidence-high"
      : props.value === "Medium"
        ? "confidence-badge confidence-medium"
        : "confidence-badge confidence-low";
  const evidenceItems = getEvidenceItems(props.card);

  return (
    <div className="confidence-meta">
      <div className="confidence-line">
        <span className="confidence-line-label">Confidence:</span>
        <span className={toneClassName}>{props.value}</span>
      </div>
      {evidenceItems.length > 0 ? (
        <div className="confidence-evidence">
          <span className="confidence-evidence-label">Evidence:</span>
          <div className="confidence-evidence-items">
            {evidenceItems.map((item) => (
              <span key={item} className="confidence-evidence-item">{item}</span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type IconIndicator = {
  id: string;
  glyph: string;
  label: string;
  text: string;
};

type TagIndicator =
  | ({ kind: "icon" } & IconIndicator)
  | { kind: "text"; id: string; text: string };

function toOperatorView(card: OpportunityCard, tone: PanelTone): {
  band: string;
  primaryLine: string;
  country: string;
  directionLine: string;
  beamHeading: string;
  confidence: string;
  reasonSummary: string;
  tagItems: readonly string[];
} {
  const directionLine = card.direction ? formatDirectionShort(card.direction) : "Direction unavailable";
  const beamHeading = typeof card.bearing === "number" && Number.isFinite(card.bearing)
    ? `${Math.round(card.bearing)}°`
    : "Unavailable";
  const conciseBeamHeading = beamHeading === "Unavailable"
    ? beamHeading
    : beamHeading.replace("Â°", "°").replace(/^(\d+)/, "~$1");
  const confidence = getConfidence(card.score);
  const callsign = safeText(
    card.callsign,
    tone === "watch"
      ? "Activity rising"
      : tone === "dx"
        ? "DX target"
        : tone === "nearby"
          ? "Portable activity"
          : "Best path",
  );

  if (tone === "watch") {
    return {
      band: safeText(card.band, "Unknown band"),
      primaryLine: callsign,
      country: formatCountry(card.countryCode),
      directionLine: card.direction ? directionLine : "Trend building",
      beamHeading: conciseBeamHeading,
      confidence,
      reasonSummary: formatOperatorSummary(card.summary, "Activity rising."),
      tagItems: card.tags,
    };
  }

  if (tone === "dx") {
    return {
      band: safeText(card.band, "Unknown band"),
      primaryLine: callsign,
      country: formatCountry(card.countryCode),
      directionLine,
      beamHeading: conciseBeamHeading,
      confidence,
      reasonSummary: formatOperatorSummary(card.summary, "DX active now."),
      tagItems: card.tags,
    };
  }

  if (tone === "nearby") {
    return {
      band: safeText(card.band, "Unknown band"),
      primaryLine: callsign,
      country: formatCountry(card.countryCode),
      directionLine: card.direction ? directionLine : "Nearby path unavailable",
      beamHeading: conciseBeamHeading,
      confidence,
      reasonSummary: formatOperatorSummary(card.summary, "Portable activity active."),
      tagItems: card.tags,
    };
  }

  return {
    band: safeText(card.band, "Unknown band"),
    primaryLine: callsign,
    country: formatCountry(card.countryCode),
    directionLine,
    beamHeading: conciseBeamHeading,
    confidence,
    reasonSummary: formatOperatorSummary(card.summary, "Best current opening."),
    tagItems: card.tags,
  };
}

function getModeIndicators(card: OpportunityCard): readonly IconIndicator[] {
  const modeKeys = new Set<string>();

  for (const tag of card.tags) {
    if (modeTags.has(tag)) {
      modeKeys.add(tag);
    }
  }

  const summary = card.summary.toUpperCase();

  if (modeKeys.size === 0) {
    if (summary.includes("DIGITAL")) {
      modeKeys.add("DIGITAL");
    } else if (summary.includes("PHONE")) {
      modeKeys.add("PHONE");
    } else if (summary.includes("CW")) {
      modeKeys.add("CW");
    }
  }

  return [...modeKeys].map((mode) => getModeIndicator(mode)).flatMap((item) => item ? [item] : []);
}

function getModeIndicator(mode: string): IconIndicator | null {
  const normalized = mode.toUpperCase();

  if (normalized === "CW") {
    return { id: "mode-cw", glyph: "·−", label: "CW Morse mode", text: "CW" };
  }

  if (normalized === "SSB" || normalized === "PHONE") {
    return {
      id: `mode-${normalized.toLowerCase()}`,
      glyph: "🎙",
      label: "SSB voice mode",
      text: normalized === "PHONE" ? "Phone" : "SSB",
    };
  }

  if (normalized === "FT8") {
    return { id: "mode-ft8", glyph: "〰", label: "FT8 digital mode", text: "FT8" };
  }

  if (normalized === "FT4") {
    return { id: "mode-ft4", glyph: "〰", label: "FT4 digital mode", text: "FT4" };
  }

  if (normalized === "DIGITAL") {
    return { id: "mode-digital", glyph: "〰", label: "Digital mode", text: "Digital" };
  }

  return null;
}

function getTagIndicator(tag: string): TagIndicator {
  const normalized = tag.toUpperCase();

  if (normalized === "SOTA") {
    return {
      kind: "icon",
      id: "tag-sota",
      glyph: "⛰",
      label: "SOTA activation",
      text: "SOTA",
    };
  }

  if (normalized === "POTA") {
    return {
      kind: "icon",
      id: "tag-pota",
      glyph: "🌲",
      label: "POTA activation",
      text: "POTA",
    };
  }

  if (normalized === "WWFF") {
    return {
      kind: "icon",
      id: "tag-wwff",
      glyph: "🍃",
      label: "WWFF activation",
      text: "WWFF",
    };
  }

  if (normalized === "/P") {
    return {
      kind: "icon",
      id: "tag-portable",
      glyph: "🎒",
      label: "Portable station",
      text: "/P",
    };
  }

  const modeIndicator = getModeIndicator(normalized);

  if (modeIndicator) {
    return { kind: "icon", ...modeIndicator };
  }

  return { kind: "text", id: `tag-${normalized}`, text: tag };
}

function getOperationIndicator(tags: readonly string[]): TagIndicator | null {
  const normalizedTags = tags.map((tag) => tag.toUpperCase());

  if (normalizedTags.includes("SOTA")) {
    return getTagIndicator("SOTA");
  }

  if (normalizedTags.includes("POTA")) {
    return getTagIndicator("POTA");
  }

  if (normalizedTags.includes("/P")) {
    return {
      kind: "icon",
      id: "operation-portable",
      glyph: "🎒",
      label: "Portable station",
      text: "Portable (/P)",
    };
  }

  if (normalizedTags.includes("/M")) {
    return {
      kind: "text",
      id: "operation-mobile",
      text: "Mobile (/M)",
    };
  }

  if (normalizedTags.includes("/MM")) {
    return {
      kind: "text",
      id: "operation-maritime",
      text: "Maritime (/MM)",
    };
  }

  if (normalizedTags.some((tag) => tag.includes("SPECIAL"))) {
    return {
      kind: "text",
      id: "operation-special-event",
      text: "Special event",
    };
  }

  return null;
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

function formatStationLine(settings: OperatorSettings): string {
  const grid = settings.homeGridValid ? settings.homeGrid.slice(0, 4) : "Not set";
  return `Location: ${grid} | HF/VHF`;
}

function formatDirectionShort(direction: string): string {
  switch (direction.trim().toUpperCase()) {
    case "NORTH":
      return "N";
    case "NORTH-EAST":
    case "NORTHEAST":
      return "NE";
    case "EAST":
      return "E";
    case "SOUTH-EAST":
    case "SOUTHEAST":
      return "SE";
    case "SOUTH":
      return "S";
    case "SOUTH-WEST":
    case "SOUTHWEST":
      return "SW";
    case "WEST":
      return "W";
    case "NORTH-WEST":
    case "NORTHWEST":
      return "NW";
    default:
      return direction;
  }
}

function formatOperatorSummary(summary: string | undefined, fallback: string): string {
  return safeText(summary, fallback)
    .replaceAll("North-East", "NE")
    .replaceAll("North-West", "NW")
    .replaceAll("South-East", "SE")
    .replaceAll("South-West", "SW")
    .replaceAll("Voice / phone likely good", "SSB likely good")
    .replaceAll("Voice likely good", "SSB likely good")
    .replaceAll("Phone likely good", "SSB likely good")
    .replaceAll("Digital likely good", "FT8/FT4 strong")
    .replace(/\b(N|NE|E|SE|S|SW|W|NW) \((\d{1,3})°\)/g, "$1 · $2°")
    .replace(/\b(N|NE|E|SE|S|SW|W|NW) \((\d{1,3})Â°\)/g, "$1 · $2°")
    .replace(/\s*,\s*/g, " · ");
}

function getEvidenceItems(card: OpportunityCard): readonly string[] {
  const signals = card.signals ?? [];
  const why = card.why ?? [];
  const confidenceReason = card.confidenceReason ?? "";
  const items: string[] = [];

  const clusterSupported = signals.some((signal) =>
    signal === "Cluster strong" || signal === "Cluster active"
  ) || why.some((item) => /\brecent spots\b/i.test(item));

  const pskSupported =
    signals.some((signal) => signal.startsWith("PSK ")) ||
    why.some((item) => item.includes("PSK confirms")) ||
    confidenceReason.includes("PSK");

  const solarSupported =
    signals.some((signal) => signal.includes("Solar supports")) ||
    why.some((item) => item.includes("MUF supports")) ||
    confidenceReason.includes("Solar");

  if (clusterSupported) {
    items.push("Cluster ✓");
  }

  if (pskSupported) {
    items.push("PSK ✓");
  }

  if (solarSupported) {
    items.push("Solar ✓");
  }

  return items;
}

function getIntelligenceChips(card: OpportunityCard, tone: PanelTone): readonly string[] {
  const chips: string[] = [];

  if (tone === "watch") {
    if (card.bandState === "Opening") {
      chips.push(card.trendLabel === "Rising" ? "Opening likely" : "Opening");
    } else if (card.trendLabel === "Rising") {
      chips.push("Building");
    } else if (card.bandState) {
      chips.push(card.bandState);
    }
  } else if (card.bandState) {
    chips.push(card.bandState);
  }

  if (card.directionConfidence) {
    chips.push(`Path ${card.directionConfidence.toLowerCase()}`);
  }

  if (tone === "dx" && card.dxEventType) {
    chips.push(card.dxEventType);
  } else if (card.strongestPropagationSignal) {
    chips.push(card.strongestPropagationSignal);
  }

  if (card.confidenceReason) {
    chips.push(card.confidenceReason);
  }

  for (const signal of card.signals ?? []) {
    if (
      !chips.includes(signal) &&
      (
        tone !== "dx" ||
        signal === card.dxEventType ||
        signal.includes("Rare DX") ||
        signal.includes("DXpedition") ||
        signal.includes("spotter") ||
        signal.includes("Multi-band")
      )
    ) {
      chips.push(signal);
    }
  }

  return chips.slice(0, tone === "watch" ? 4 : 3);
}

function getWhyItems(card: OpportunityCard, tone: PanelTone): readonly string[] {
  const items = [...(card.why ?? [])];

  if (tone === "watch" && card.signals) {
    for (const signal of card.signals) {
      if (
        (signal.includes("rising") || signal.includes("increasing") || signal.includes("Solar supports")) &&
        !items.includes(signal)
      ) {
        items.push(signal);
      }
    }
  }

  if (tone === "best" && card.strongestPropagationSignal && !items.includes(card.strongestPropagationSignal)) {
    items.push(card.strongestPropagationSignal);
  }

  return items.slice(0, 4);
}

function parseSolarNumber(value: number | string | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (!value || value === "—") {
    return null;
  }

  const numericValue = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(numericValue) ? numericValue : null;
}

function formatSolarNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatSolarValue(value: number | string | undefined): string {
  const numericValue = parseSolarNumber(value);
  return numericValue !== null ? formatSolarNumber(numericValue) : "—";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
    return "—";
  }

  try {
    const label = countryDisplayNames?.of(countryCode.toUpperCase());
    return label && label.trim().length > 0 ? label : countryCode.toUpperCase();
  } catch {
    return countryCode.toUpperCase();
  }
}

function countryCodeToFlagEmoji(countryCode: string | undefined): string | undefined {
  const normalized = normalizeCountryCode(countryCode);

  if (!normalized) {
    return undefined;
  }

  const codePoints = [...normalized].map((letter) => {
    const codePoint = letter.codePointAt(0);
    return codePoint ? codePoint + 127397 : 0;
  });

  return codePoints.length === 2
    ? String.fromCodePoint(...codePoints)
    : undefined;
}

function normalizeCountryCode(countryCode: string | undefined): string | undefined {
  if (!countryCode) {
    return undefined;
  }

  const normalized = countryCode.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

function formatSolarUpdatedAt(value: string | undefined): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "—";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
