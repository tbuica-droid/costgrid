# Operating CostGrid

For whoever runs a hosted or self-hosted gateway: what "working" means in
numbers, what to alert on, what to do when an alert fires, and how to learn
from an incident. Setup is in [HOSTING.md](HOSTING.md).

## What "working" means

Three things matter to a customer, in this order: their calls get through,
CostGrid does not make them noticeably slower, and every call is counted.
Each has an indicator (SLI), measured from `/metrics`, and a target (SLO)
over a rolling 30 days. The error budget is what the target leaves over.

| | SLI | SLO | Error budget (30 days) |
|---|---|---|---|
| **Available** | Proxied calls not failed by CostGrid itself (5xx that are not the provider's) | 99.9% | about 43 minutes of total outage, or 0.1% of calls |
| **Fast** | Time from a call arriving to it being forwarded (`costgrid_preforward_seconds`) | 99% under 50 ms | 1% of calls may take longer |
| **Counted** | Calls served and recorded (`costgrid_metering_failures_total`) | 99.99% | 1 call in 10,000 |

Measure "fast" with `npm run bench` (CostGrid's own cost against a local stub)
and confirm it under load with `npm run soak`. Revisit the targets after a
month of real traffic: a target nobody can meet is ignored, and one met
without effort protects nothing.

**Spending the error budget.** While a budget has room, ship as normal. When
a month's budget is gone, releases that are not fixes wait until it recovers,
and the next piece of work is whatever burned it.

## Alerts

Prometheus rules for the targets above and for the things that break quietly.
Page for the first group; the second can wait for working hours.

```yaml
groups:
  - name: costgrid-page
    rules:
      - alert: CostGridDown
        expr: up{job="costgrid"} == 0
        for: 2m
      - alert: CostGridNotReady
        # /ready failing for 5 minutes: database closed or schema behind.
        expr: probe_success{job="costgrid-ready"} == 0
        for: 5m
      - alert: CostGridFailingCalls
        # 5xx from CostGrid itself, burning the monthly budget 14x too fast.
        expr: |
          (
            sum(rate(costgrid_http_requests_total{route=~"/v1/messages|/v1/chat/completions|/v1/vertex/messages|/model/.*",status="5xx"}[5m]))
            - sum(rate(costgrid_upstream_errors_total[5m]))
          ) / sum(rate(costgrid_http_requests_total{route=~"/v1/messages|/v1/chat/completions|/v1/vertex/messages|/model/.*"}[5m])) > 14 * 0.001
        for: 5m
      - alert: CostGridNotCounting
        # Calls served but not recorded: figures are understated from now on.
        expr: increase(costgrid_metering_failures_total[10m]) > 0
  - name: costgrid-ticket
    rules:
      - alert: CostGridSlow
        expr: |
          histogram_quantile(0.99, sum by (le) (rate(costgrid_preforward_seconds_bucket[15m]))) > 0.05
        for: 30m
      - alert: CostGridJobFailing
        # Backups, key sync, retention or anchoring failed.
        expr: increase(costgrid_job_failures_total[6h]) > 0
      - alert: CostGridProviderErrors
        expr: sum by (provider) (rate(costgrid_upstream_errors_total[10m])) > 0.5
        for: 10m
      - alert: CostGridMemoryGrowing
        expr: deriv(costgrid_heap_used_bytes[6h]) > 5e6 / 3600
        for: 6h
```

The route pattern lists the proxy routes (Anthropic, OpenAI, Vertex, Bedrock); add any provider you add. Each alert should name a
runbook below; one that does not is a candidate for deletion.

## Runbooks

Each starts with what to check, then what to do. Find a customer's request
in the log by the `x-costgrid-request-id` they quote.

### CostGridDown or CostGridNotReady

1. `curl https://<host>/health` and `/ready`. Alive but not ready means the
   database: read the reason in the `/ready` body.
2. "migration(s) not applied": the process started on a newer build than its
   database and could not migrate. The log says why. Roll back the image, or
   fix and restart; the copy taken before the migration is beside the
   database as `costgrid.db.before-migration-<n>.bak`.
3. Not alive: check the container's exit reason and the last log lines. A
   disk that is full shows as SQLite errors (see below).

### CostGridNotCounting (metering failures)

Calls are being answered but not recorded, so spend, budgets and statements
understate from the first failure. The gateway keeps serving on purpose.

1. `/health` shows `meteringFailures` and when the last one happened; the log
   line `METERING WRITE FAILED` has the reason.
2. Almost always the disk: full or read-only. Free space or grow the volume.
3. Tell affected customers which window is understated. The provider's own
   usage report (Import) is the record for that window.

### Disk full

1. Check the backups folder first: `COSTGRID_BACKUP_KEEP` copies of the whole
   database. Lower it or move `COSTGRID_BACKUP_DIR` to another volume.
2. Check retention: organisations with no call retention set keep every call.
3. Grow the volume. Deleting the WAL or SHM files corrupts the database;
   never do it.

### A provider is down (CostGridProviderErrors)

Not CostGrid's failure, and calls fail with the provider's error passed
through. Check the provider's status page. Nothing to do on CostGrid's side;
budget fallbacks still apply to whatever does get through.

### Restoring the database

1. Stop the gateway.
2. From Litestream: `litestream restore -o /data/costgrid.db <replica-url>`.
   From a daily copy: copy `backups/costgrid-<day>.db` to `costgrid.db` and
   delete any `costgrid.db-wal` and `costgrid.db-shm` beside it first.
3. Start the gateway; it migrates the copy if it is older than the build.
4. Calls between the backup and the failure are missing. Tell affected
   customers, and point them at Import for that window.

### The master key leaked, or might have

1. Generate a new one: `openssl rand -base64 48`.
2. Stop the gateway and run `rotate-master-key` (HOSTING.md).
3. Start with the new key and delete the pre-rotation copy.
4. Every backup taken before the rotation still opens with the old key.
   Treat those as exposed: delete them, or rotate tenants' provider keys.

### The master key is lost

Stored provider keys, SSO secrets and alert addresses cannot be recovered.
Start with a new key; the gateway says which secrets it cannot read, and each
organisation re-enters them. Usage history is unaffected.

### A customer says the figures are wrong

1. Get the request id or the time and agent.
2. Compare with the provider's usage report for the same day (Import).
3. Check `meteringFailures`, and whether calls went around CostGrid.
4. Check the price list is current: `scripts/verify-pricing.mjs`.

## Incidents

**Severity.**

| Level | Meaning | Response |
|---|---|---|
| 1 | Calls failing or not counted for many customers | Page now; updates every 30 minutes |
| 2 | One customer, or a degraded feature (slow, alerts not sent, console down) | Within working hours, same day |
| 3 | Cosmetic, or a workaround exists | Normal queue |

**During one.** One person leads and writes a timeline as they go. Say what
customers see on the status page early, even if the cause is unknown;
"investigating" beats silence. Fix first, explain later.

**On call.** One named person per week, with a second as backup, reachable
for severity 1. Hand over with a note of anything open. Until there is a team
to rotate, write down who that is anyway, so it is a decision rather than an
assumption.

## Postmortems

Within five working days of any severity 1 or 2, and blameless: the question
is what let it happen, not who. Copy this:

```markdown
# <date>: <one-line summary>

**Severity:** 1 / 2    **Duration:** <start> to <end> (<minutes>)
**Customers affected:** <who, and what they saw>
**Error budget spent:** <minutes or calls, of which SLO>

## Timeline
- hh:mm what happened, what was noticed, what was done

## What went wrong
The chain of causes, technical and process, down to the ones we can change.

## What went right
What limited the damage, so it is kept.

## Actions
| Action | Owner | Due |
|---|---|---|
| Prevents it happening again | | |
| Detects it sooner | | |
| Makes recovery faster | | |
```

Keep them in `docs/postmortems/`. An action without an owner and a date will
not happen.
