# Running CostGrid as a hosted service

CostGrid has two modes. Self-hosted is one organisation running it for
themselves, with the operator's provider keys in environment variables. Hosted
is a service other people sign up for, bringing their own keys.

The distinction is one flag, but it changes the trust model completely. In
hosted mode you hold other companies' provider credentials, which spend their
money.

## What hosted mode adds

| | Self-hosted | Hosted |
|---|---|---|
| Provider keys | Operator's, from env vars, shared by all traffic | Each tenant's own, encrypted at rest |
| Accounts | None | Signup, login, sessions, roles |
| Console at `/console` | Not served | Signup and org settings |
| Rate limits | Effectively none | Per tenant, from their plan |
| Billing | None | Invoice basis computed per tenant |
| `COSTGRID_ALLOW_ANONYMOUS` | Allowed | Rejected at boot |

## Configuration

```bash
COSTGRID_HOSTED=true
COSTGRID_MASTER_KEY=<48+ random bytes>   # required
COSTGRID_SECURE_COOKIES=true             # defaults to true when hosted
COSTGRID_DB=/data/costgrid.db
COSTGRID_HOST=0.0.0.0
```

Generate the master key once:

```bash
openssl rand -base64 48
```

### The master key is the most important secret you hold

It decrypts every tenant's provider credentials. Three consequences:

-  - **Losing it makes every stored credential unrecoverable.** Tenants would
  have to re-enter their keys. The gateway detects this and says so rather than
  sending garbage upstream. - **Leaking it, together with a database dump,
  exposes every tenant's provider key.** Either alone is not enough. That is
  the point of holding it outside the database. - **Changing it does not
  re-encrypt anything.** There is no key-rotation path in this release;
  rotating means asking every tenant to re-enter their key.

Keep it in a secrets manager, not in the image, not in the repo, not in a
shell command that lands in history.

## Deploying

```bash
docker build -t costgrid .

docker run -d --name costgrid \
  -p 8787:8787 \
  -v costgrid-data:/data \
  -e COSTGRID_HOSTED=true \
  -e COSTGRID_MASTER_KEY="$(cat /run/secrets/costgrid_master_key)" \
  costgrid
```

The image runs as a non-root user, carries no compiler or test framework, and
has a healthcheck on `/health`.

> Not verified on this machine. Docker was not installed where this was >
written, so the image has never been built. The compiled entrypoint it runs >
(`packages/gateway/dist/main.js`) was started directly and serves `/health` >
and `/console` correctly. Build it once before trusting it.

**Terminate TLS in front of it.** Session cookies are `Secure` in hosted mode,
so plain http will not keep anyone signed in. Which is the correct failure.
Provider keys and API keys cross this connection.

## Onboarding a customer

The fastest path to showing value, and the one to use in a sales call:

1.  1. They sign up at `/console`. 2. **Import**. They paste a provider *admin*
   key and CostGrid pulls their last 90 days from the provider's usage report.
   Their own numbers are on screen in under a minute, before anything is
   integrated. 3. They add a provider API key and point one service at the
   gateway. 4. Metered spend, per-agent attribution and enforcement start from
   there.

Step 2 matters because without it a prospect's first experience is an empty
dashboard, which cannot be demoed and cannot be sold from.

**The admin key is not stored.** It is used for that one request and dropped.
Worth saying out loud, because "can read our whole organisation's usage" is
exactly the permission a security reviewer will stop on.

Imported history is shown in its own labelled section and never merged into
metered figures. It is daily totals with no per-agent attribution and nothing
enforceable, and the UI says so.

## Operating

### Backups

```bash
docker exec costgrid node packages/cli/dist/main.js backup /data/backup.db
```

Use this rather than copying the file. WAL mode keeps recent commits in a
sidecar until checkpoint, so `cp` silently loses the newest calls. The ones a
customer is most likely to be asking about.

A backup contains encrypted credentials, not plaintext, but it is still
customer data. Treat it accordingly.

### Price freshness

```bash
docker exec costgrid node scripts/verify-pricing.mjs
```

Run it on a schedule. Exit 1 means a rate changed and you are billing wrong;
exit 2 means the page could not be fetched, which is *inconclusive* and must
not be treated as a pass.

### Sessions

Expired sessions are swept hourly by the process itself. Nothing to do.

## What is deliberately not built

**No payment processor.** Changing a plan records the intent; nobody's card is
charged. `GET /console/:tenant/billing` returns the invoice basis. Base fee,
usage fee, metered spend, call count. And an operator collects. Charging money
automatically is a real-world action that belongs behind an explicit,
deliberate integration.

**SQLite, so one node.** Every construct in the schema is Postgres-portable and
the repository layer is the only code that writes SQL, but the swap has not
been made. Until it is: one gateway instance, one disk, no horizontal scale and
no HA. For early customers this is genuinely fine; it is not fine at scale, and
it should not be sold as if it were.

**In-process rate limiting.** Each instance enforces its own counter, so the
effective limit is `plan limit x instances`. With one instance that is exact.
A multi-node deployment needs a shared counter.

**No email.** No verification, no password reset, no invitations. A user who
forgets their password needs an operator with database access. Adding a member
to an organisation is currently a server-side call, not a UI flow.

**No audit log of console actions.** Metering and policy events are recorded;
who changed a credential or a plan is not.

Each of these is a real gap rather than a rough edge. They are listed here so
the decision to launch with them is made deliberately, and so a prospect asking
"can you scale?" or "what happens if I forget my password?" gets an honest
answer.
