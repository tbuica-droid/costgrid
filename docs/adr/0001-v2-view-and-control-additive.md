# ADR-0001: CostGrid v2 — View and View-and-control, added to the existing app

**Status:** Accepted
**Date:** 23 October 2026
**Deciders:** Tomas Buica (product owner)

## Context

CostGrid today is a metering proxy. The desktop app (Electron) starts the gateway in-process and shows its web console (`packages/desktop/src/main.ts`, `packages/gateway/src/start.ts`). Every AI call that goes through the proxy is priced, can be blocked or rerouted, and is recorded per run.

The v2 direction (docs/strategy/, gap report of 15 October 2026) changes the headline. CostGrid should tell a small business what each **successful** AI job costs (Levelized Cost per Successful Outcome, LCSO), and help it keep agents and keys under control, without ever reading content. The first audience is non-technical owners of 5–99 person businesses whose agents usually run in n8n or on a freelancer's server, not on the owner's computer.

Forces:

- **Data source.** Provider usage reports (Admin API or a CSV export) give totals per key, project or workspace and model, in time buckets. They have no run or task records. LCSO's failure share and per-job cost spread need per-run records, which only the proxy (or a webhook or automation log) provides.
- **Provider control surfaces differ** (official docs, checked 15 October 2026):
  - Anthropic can pause a key by API (`status: inactive`, reversible) but has no spend-cap API for Console organisations.
  - OpenAI has hard project and organisation spend caps by API (enforcement "is not instantaneous") but no documented key pause.
  - Anthropic admin keys are always read-write. OpenAI admin keys are owner-only.
- **Privacy promise.** By default nothing leaves the computer. Keys belong in the operating system's secure store.
- **Product owner constraint.** v2 is an addition to the existing product, not a rebuild.

## Decision

1. **Build v2 on top of the existing app.** The desktop app keeps running the embedded gateway. The proxy, routing, per-run limits and current screens stay. New capabilities are added beside them.
2. **Two tiers behind a plan flag.**
   - **View** (free): costs, cost per successful job, failure share, cost spread, key-safety warnings.
   - **View and control** (paid, opt-in): pause or resume an agent's key, spending caps, alerts, measured stop time.
   - No payment integration until it is separately approved.
3. **Two data paths, one engine.** A pure LCSO engine in `packages/core` (`lcso.ts`) takes:
   - **per-task records** (proxy runs; later an outcome webhook or an automation tool's execution log), which give the full LCSO: levels 1–3, failure share and spread;
   - **aggregates** (provider usage reports or CSV) plus a success count, which give LCSO levels 1–3 only, with failure share and spread marked "not reported".
4. **Caps come in two kinds and are labelled differently.**
   - A **provider cap** is a hard stop at the provider: set by API on OpenAI, one project per agent; set by the owner in the Anthropic Console through a guided walkthrough.
   - A **CostGrid cap** polls usage and pauses the key. Its stop time includes the provider's reporting lag, so it is measured and published, never described as instant.
5. **Secrets.** Provider and admin keys go in macOS Keychain or Windows Credential Manager through one keyring library. Electron `safeStorage` stays only for the database master key. A stored admin key keeps its expiry date so the app can remind the owner.
6. **Sign-in.** A local profile for View. A cloud account is requested only when the owner turns on View and control. It is opt-in, and the owner first sees a plain list of what leaves the computer.

## Options considered

### Option A: add v2 to the existing app (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low to medium: new modules and screens beside existing ones |
| Cost | Lowest; reuses importers, alerts, results tab, statement, policy engine |
| Risk | LCSO and Control changes sit near the proxy code (`server.ts`); covered by tests |
| Team familiarity | High |

**Pros:** keeps everything that works; proxy users get the full LCSO immediately because they already produce per-run records; smallest change for current users.
**Cons:** the app keeps a local proxy listening on port 8787 even for owners who only use View; one-person app still contains multi-tenant code (single sign-on, billing plans, rate limiter).

### Option B: split a "local service" out of the gateway; proxy only on servers

| Dimension | Assessment |
|---|---|
| Complexity | Medium: move database, importers, alerts and console routes into a new package |
| Cost | Higher; touches most gateway tests' imports |
| Risk | Regressions in a working product during the move |
| Team familiarity | High |

**Pros:** smaller attack surface on the owner's computer; cleaner boundary for future work.
**Cons:** a rebuild the product owner explicitly does not want for v2.

## Trade-off analysis

Option B is architecturally tidier, but its benefits (no local proxy port, less shipped code) don't change what the owner sees, and it delays v2 features. Option A gets cost per successful job and Control into owners' hands sooner and keeps the per-run data path alive, which the full LCSO depends on. The local-proxy surface is mitigated by the existing loopback-only binding and CSRF guards, and is revisited if a security review finds it material.

## Consequences

- **Easier:** shipping LCSO quickly; proxy users get failure share and spread from day one; no migration for current users.
- **Harder:** keeping LCSO and Control code out of the metering path in `packages/gateway/src/server.ts`; explaining two levels of LCSO detail (per-task vs aggregate) in plain language.
- **Revisit:**
  - the local-service split if the desktop app's proxy surface or startup cost becomes a problem;
  - OpenAI "pause" (a $0 project cap or model deny-list) once tested on a real project;
  - whether Anthropic exposes a spend-cap API or read-only admin keys.

## Action items

1. [ ] LCSO engine in `packages/core` with the method §14 example as a golden test (build step 1).
2. [ ] Visual refresh of the app and website (approved style tile first).
3. [ ] Three-step setup with CSV drag-in, "ask my developer" and stored admin keys in the OS store (build step 2).
4. [ ] Plan flag for View / View and control in `packages/core/src/billing.ts` (build step 8).
5. [ ] Measure stop time for both cap kinds before any copy mentions it.
