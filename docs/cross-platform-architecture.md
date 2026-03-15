# Cross-Platform Opportunity Architecture

Radio Pilot is being refactored so the opportunity engine can run unchanged across:

- hosted web/API with Redis
- packaged desktop with SQLite or in-memory storage
- mobile clients fed from local cache or synced API data

## Shared boundaries

The current shared package now exposes clearer submodule boundaries:

- `shared-types`
  - canonical data contracts
  - opportunity cards
  - solar, PSK, propagation, and scoring types
- `shared-geo`
  - band derivation
  - Maidenhead/grid helpers
  - distance and bearing helpers
- `shared-scoring`
  - centralized scoring weights and thresholds
  - safe tuning surface for calibration
- `shared-engine`
  - pure opportunity generation
  - propagation and DX logic
  - runtime helpers that build snapshots from typed inputs
- `shared-storage`
  - storage abstraction interfaces
  - Redis-backed hosted implementation

## Core principle

The engine should consume typed inputs, not Redis directly.

That means:

- pure scoring and ranking stay inside shared logic
- storage implementations are adapters
- hosted, desktop, and mobile runtimes can each provide the same engine inputs

## Storage contract

`packages/shared/src/shared-storage/types.ts`

Defines `OpportunityInputStorage` with methods such as:

- `getSolar()`
- `getRecentSpots()`
- `getPskSummaries()`
- `getPskTrends()`
- `getBandPredictions()`
- `getDirectionalSummaries()`
- `getDxRarity()`
- `getDxEvents()`

This is the seam for future platform-specific storage:

- Redis adapter for hosted web
- SQLite adapter for desktop
- in-memory / synced cache adapter for mobile

## Hosted path

`packages/shared/src/shared-storage/redisOpportunityStorage.ts`

This is the current hosted implementation.

It:

- reads Redis keys
- parses Redis payloads into typed engine inputs
- computes derived artifacts already used in production
  - band predictions
  - propagation density
  - DX rarity
  - DX events

## Runtime composition

`packages/shared/src/shared-engine/runtime.ts`

Provides:

- `loadOpportunityEngineInputs(storage, options)`
- `buildOpportunitySnapshotFromInputs(inputs, query)`
- `buildOpportunitySnapshotOnlyFromInputs(inputs, query)`

This is the new platform-agnostic runtime layer:

- storage loads typed inputs
- runtime builds the snapshot
- UI/API consumes the snapshot

## Current API integration

`apps/api/src/server.ts`

The API now:

- creates `RedisOpportunityStorage`
- caches loaded engine inputs
- builds filtered snapshots from those inputs

So the server is now mostly orchestration, not engine logic.

## Tuning safety

Weights are now centralized in:

- `packages/shared/src/scoringConfig.ts`

Developers should tune there, then validate with:

- `pnpm replay:snapshot <fixture>`
- `pnpm test:opportunity-regression`
- `http://localhost:5173/?devReview=1`

## Next adapters

Not implemented yet, but now straightforward:

- `SqliteOpportunityStorage`
- `InMemoryOpportunityStorage`
- `ApiCacheOpportunityStorage`

Each would satisfy `OpportunityInputStorage` and reuse the same shared engine.
