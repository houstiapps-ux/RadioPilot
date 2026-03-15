# Opportunity Calibration Checklist

Use this checklist when tuning Radio Pilot recommendation weights.

## Safe workflow

1. Change one weight group at a time in `packages/shared/src/scoringConfig.ts`.
2. Replay a known fixture before and after the change.
3. Run the regression suite.
4. Inspect live behavior in the dev review panel.
5. Only then make another tuning change.

Do not change ranking weights and empty-state thresholds in the same pass unless a regression explicitly requires it.

## Core commands

Capture a fresh fixture:

```bash
pnpm snapshot:opportunities -- --homeGrid=IO64 --name=calibration-run
```

Replay a fixture:

```bash
pnpm replay:snapshot fixtures/opportunity-snapshots/regression-strong-20m-current.json
```

Run regression tests:

```bash
pnpm test:opportunity-regression
```

Open the developer review panel:

```text
http://localhost:5173/?devReview=1
```

## Scenario checklist

### 1. Strong current 20m activity

Expected:
- `Best Opportunity` stays on `20m`
- confidence remains `Medium` or `High`
- `Watch Next` does not displace the strongest current band without a real opening signal

Fixture:
- `fixtures/opportunity-snapshots/regression-strong-20m-current.json`

Primary knobs:
- `OPPORTUNITY_SCORING.bandBase`
- `OPPORTUNITY_SCORING.aggregate`
- `OPPORTUNITY_SCORING.pskBoost`

### 2. Early high-band opening

Expected:
- `Watch Next` prefers the opening band
- `bandState = Opening`
- `trendLabel = Rising`

Fixture:
- `fixtures/opportunity-snapshots/regression-high-band-opening.json`

Primary knobs:
- `OPPORTUNITY_SCORING.watchThresholds`
- `OPPORTUNITY_SCORING.pskBoost`
- `OPPORTUNITY_SCORING.propagationBoost`

### 3. Rare DX event

Expected:
- `DX Opportunity` surfaces the rare/eventful target
- it should not duplicate `Best Opportunity` unless rarity/event strength is genuinely high

Fixture:
- `fixtures/opportunity-snapshots/regression-rare-dx-active.json`

Primary knobs:
- `DX_EVENT_SCORING.eventTypeStrength`
- `OPPORTUNITY_SCORING.dxMeaningfulThresholds`
- `OPPORTUNITY_SCORING.dxIntentBoost`

### 4. Nearby portable activation

Expected:
- `Nearby Activity` remains local/regional
- portable activations survive nearby hardening
- weak non-portable extended-regional noise stays suppressed

Fixture:
- `fixtures/opportunity-snapshots/regression-nearby-portable.json`

Primary knobs:
- `NEARBY_SCORING.weights`
- `NEARBY_SCORING.thresholds`

### 5. Poor solar / weak path

Expected:
- confidence and support chips should degrade
- weak path evidence should not be promoted into strong DX/watch recommendations

Check:
- use the dev review panel to inspect `confidenceReason`, `supportChips`, and candidate rejection reasons

Primary knobs:
- `OPPORTUNITY_SCORING.propagationBoost`
- `OPPORTUNITY_SCORING.dxMeaningfulThresholds`

### 6. Strict filter with no matches

Expected:
- cards return empty states cleanly
- no contradictory confidence, evidence, or match metadata leaks into the UI

Fixture:
- `fixtures/opportunity-snapshots/regression-no-opportunity-strict-filter.json`

Primary knobs:
- hard-filter logic in `opportunities.ts`
- avoid compensating for filter misses by increasing generic ranking weights

### 7. VHF/UHF-only case

Expected:
- HF opportunities stay suppressed
- nearby/regional VHF/UHF paths can still surface when present

Check:
- run a live request with `bandScope=vhf-uhf`
- inspect `filterMatchLabels` and candidate rejection reasons in the dev review panel

## Tuning guidance

- Raise `bandBase` or `aggregate` weights only when strong current activity is under-ranked.
- Raise `watchThresholds` or `pskBoost` only when genuine openings are being missed.
- Raise `dxMeaningfulThresholds` carefully; too high will blank the DX card too often.
- Raise `NEARBY_SCORING.thresholds` only if nearby cards are too noisy.
- Treat `DX_EVENT_SCORING` as a bias layer, not a replacement for path and activity evidence.

## What to avoid

- Do not tune against a single live moment.
- Do not use UI copy changes to hide scoring problems.
- Do not change multiple subsystems at once without replaying fixtures.
