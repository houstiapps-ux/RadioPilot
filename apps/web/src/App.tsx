import type { ReactNode } from "react";
import { useEffect, useState } from "react";

type OpportunityCard = {
  id: string;
  callsign: string;
  band: string | null;
  frequencyKHz: number;
  summary: string;
  tags: readonly string[];
  score: number;
};

type OpportunitySnapshot = {
  generatedAt: string;
  cards: readonly OpportunityCard[];
  bestOpportunity: OpportunityCard | null;
  watchNext: readonly OpportunityCard[];
  dxOpportunity: OpportunityCard | null;
  nearbyActivity: readonly OpportunityCard[];
};

type LoadState = "loading" | "success" | "error";

const opportunitiesUrl = "http://localhost:3000/api/opportunities";
const pollIntervalMs = 30_000;
const portableTags = new Set(["SOTA", "POTA", "WWFF", "/P"]);
const frequencyFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function App() {
  const [snapshot, setSnapshot] = useState<OpportunitySnapshot | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | undefined;

    async function load() {
      try {
        const response = await fetch(opportunitiesUrl);

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

    void load();
    intervalId = window.setInterval(() => {
      void load();
    }, pollIntervalMs);

    return () => {
      cancelled = true;

      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, []);

  return (
    <main className="dashboard">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Radio Pilot</p>
          <h1>What should I work right now?</h1>
          <p className="subtitle">Live guidance for the strongest opportunities from your location.</p>
        </div>
        <div className="hero-meta">
          <StatusBadge state={loadState} />
          <div className="updated-at">
            <span className="meta-label">Last updated</span>
            <span className="meta-value">{formatLastUpdated(snapshot?.generatedAt)}</span>
          </div>
        </div>
      </header>

      <div className="dashboard-grid">
        <SectionCard title="Best Opportunity" featured>
          <OpportunityDetails
            card={snapshot?.bestOpportunity ?? null}
            emptyMessage="No clear top recommendation yet."
            featured
          />
        </SectionCard>

        <SectionCard title="Watch Next">
          <OpportunityList
            cards={snapshot?.watchNext ?? []}
            emptyMessage="Nothing building behind the lead band right now."
          />
        </SectionCard>

        <SectionCard title="DX Opportunity">
          <OpportunityDetails
            card={snapshot?.dxOpportunity ?? null}
            emptyMessage="No DX lead is standing out yet."
          />
        </SectionCard>

        <SectionCard title="Nearby Activity">
          <OpportunityList
            cards={snapshot?.nearbyActivity ?? []}
            emptyMessage="No portable activity is standing out nearby."
            emphasizePortableTags
          />
        </SectionCard>
      </div>
    </main>
  );
}

function StatusBadge(props: { state: LoadState }) {
  const toneClass =
    props.state === "success"
      ? "status-badge status-live"
      : props.state === "error"
        ? "status-badge status-error"
        : "status-badge status-loading";
  const label =
    props.state === "success"
      ? "Live data loaded"
      : props.state === "error"
        ? "Connection issue"
        : "Loading data";

  return (
    <div className={toneClass}>
      <span className="status-dot" />
      <span>{label}</span>
    </div>
  );
}

function SectionCard(props: {
  title: string;
  children: ReactNode;
  featured?: boolean;
}) {
  return (
    <section className={props.featured ? "section-card section-card-featured" : "section-card"}>
      <div className="section-head">
        <h2>{props.title}</h2>
      </div>
      {props.children}
    </section>
  );
}

function OpportunityDetails(props: {
  card: OpportunityCard | null;
  emptyMessage: string;
  featured?: boolean;
  emphasizePortableTags?: boolean;
}) {
  if (!props.card) {
    return <EmptyState message={props.emptyMessage} />;
  }

  return (
    <article className={props.featured ? "opportunity opportunity-featured" : "opportunity"}>
      <div className="opportunity-topline">
        <div>
          <div className="band-pill">{safeText(props.card.band, "Unknown band")}</div>
          <div className="callsign">{safeText(props.card.callsign, "Unknown callsign")}</div>
        </div>
        <div className="frequency">{formatFrequency(props.card.frequencyKHz)}</div>
      </div>
      <p className="summary">{safeText(props.card.summary, "No summary available.")}</p>
      <TagList tags={props.card.tags} emphasizePortableTags={props.emphasizePortableTags} />
    </article>
  );
}

function OpportunityList(props: {
  cards: readonly OpportunityCard[];
  emptyMessage: string;
  emphasizePortableTags?: boolean;
}) {
  if (props.cards.length === 0) {
    return <EmptyState message={props.emptyMessage} />;
  }

  return (
    <div className="opportunity-list">
      {props.cards.map((card) => (
        <OpportunityDetails
          key={card.id}
          card={card}
          emptyMessage={props.emptyMessage}
          emphasizePortableTags={props.emphasizePortableTags}
        />
      ))}
    </div>
  );
}

function TagList(props: {
  tags: readonly string[];
  emphasizePortableTags?: boolean;
}) {
  if (props.tags.length === 0) {
    return (
      <div className="tag-row">
        <span className="tag-empty">None</span>
      </div>
    );
  }

  return (
    <div className="tag-row">
      {props.tags.map((tag) => {
        const portableClass =
          props.emphasizePortableTags && portableTags.has(tag)
            ? "tag tag-portable"
            : "tag";

        return (
          <span key={tag} className={portableClass}>
            {tag}
          </span>
        );
      })}
    </div>
  );
}

function EmptyState(props: { message: string }) {
  return <div className="empty-state">{props.message}</div>;
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

function safeText(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
