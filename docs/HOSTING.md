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

- **Losing it makes every stored credential unrecoverable.** Tenants would have
  to re-enter their keys. The gateway detects this and says so rather than
  sending garbage upstream.
- **Leaking it, together with a database dump, exposes every tenant's provider
  key.** Either alone is not enough. That is the point of holding it outside
  the database.
- **Changing it does not re-encrypt anything.** There is no key-rotation path
  in this release, so rotating means asking every tenant to re-enter their key.

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

**Tell it which proxy to trust.** Set `COSTGRID_TRUST_PROXY` to `true`, or to
a comma-separated list of the proxy's IPs or CIDR ranges. With it set, a
hosted gateway redirects any request the proxy reports as plain http to https
(to `COSTGRID_PUBLIC_URL` when that is https), and sign-in rate limits count
each visitor's own address. Without it, every visitor arrives from the proxy's
address and shares one sign-in limit, so one person hammering the login can
lock everyone out. HSTS is sent in hosted mode either way.

## Onboarding a customer

The fastest path to showing value, and the one to use in a sales call:

1. They sign up at `/console`.
2. **Import.** They paste a provider *admin* key and CostGrid pulls their last
   90 days from the provider's usage report. Their own numbers are on screen in
   under a minute, before anything is integrated.
3. They add a provider API key and point one service at the gateway.
4. Metered spend, per-agent attribution and enforcement start from there.

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

## The audit log

Every change a person makes is recorded: who signed in, who added a provider
key, who changed a budget, who turned enforcement off. Metering already
recorded what the software did; this records what people did to the software.

Each entry carries the hash of the entry before it. Changing or removing any
entry changes its hash, which breaks the link the next entry recorded, and
every link after that. That makes a change **detectable**, which is what
"tamper-evident" means. It is a weaker claim than "tamper-proof", and unlike
that one it is true: the database belongs to the customer, and nothing stored
in it can be made unchangeable.

```bash
costgrid audit list --days 30      # what happened
costgrid audit verify              # does the chain still hold
costgrid audit head                # the fingerprint to record elsewhere
```

**`audit head` is the part that turns detection into proof.** It prints a hash
committing to the entire history. Copy it somewhere CostGrid cannot reach: an
email to whoever owns the audit, a ticket, a board minute. Any later change to
anything written before that moment becomes provable rather than merely
suspected. Without that step, someone who deletes the newest entries leaves a
chain that still verifies, because what is missing links to nothing.

`costgrid audit verify` exits 2 when the chain does not hold, so it can be run
on a schedule beside the pricing check.

### Anchoring it somewhere you control

A hash chain proves something to whoever holds an older copy of the head.
`costgrid audit head` prints one for a person to file somewhere, which makes
the guarantee depend on that person remembering, and the person an audit
concerns is the one being asked to remember.

Anchoring removes that dependency. CostGrid signs its current fingerprint and
posts it on a schedule to a system you control separately: a SIEM, a log
collector, an auditor's endpoint.

```bash
costgrid audit keys           # make a signing key, once
```

```bash
COSTGRID_ANCHOR_URL=https://siem.internal/costgrid
COSTGRID_ANCHOR_KEY="$(cat /run/secrets/costgrid_anchor_key)"
COSTGRID_ANCHOR_INTERVAL_MINUTES=60
```

The receiver needs only the **public** key. They can then prove an anchor came
from your CostGrid unaltered, and they cannot forge one, which is why this is a
signature rather than a shared secret: an anchor in their archive is evidence
even when the two of you disagree.

**Be precise about what this buys, because it is not immutability.** Whoever
controls the host controls the sender and the key. They can stop anchoring, and
they can sign a false anchor. What they cannot do is reach into the receiver
and change an anchor already delivered. So:

| Tampering | How it surfaces |
|---|---|
| An old entry is edited | The head no longer matches the anchor already held for that sequence |
| Recent entries are deleted | The head moves backwards, below a sequence already committed to |
| The chain is rebuilt to hide an edit | Local verification passes; the archived anchor still disagrees |
| Anchoring is switched off first | The stream stops, and anchors are sent on a heartbeat so silence is itself the signal |

The last row is why an anchor is sent even when nothing has changed, and why
it carries its own sequence number. Alarm on **absence**, not only on content.

`costgrid audit anchors` shows what was sent and what never arrived.
Undelivered anchors are the interesting ones: a gap in the archive is exactly
what somebody covering their tracks would leave, so they are retried
indefinitely rather than dropped.

## Single sign-on

OpenID Connect, one connection per organisation. Configured by an owner at
`/console`, or by hand against `PUT /console/:tenantId/sso`.

The customer needs to register one redirect URI with their identity provider,
and the console prints the exact string to paste. **Set `COSTGRID_PUBLIC_URL`**
before doing this: without it the redirect is built from whatever `Host` header
arrived, which works but makes a mismatch confusing to diagnose.

`emailDomains` is not a convenience. An identity provider issues valid tokens
for everybody in its directory, and it is the same provider for thousands of
organisations, so a token proves who somebody is and not that they belong here.
The domain list is what turns the first into the second.

With `enforced` on, password login is refused for addresses in those domains,
including correct passwords. That is usually the reason a customer bought SSO.

## Data retention

Three windows, all defaulting to zero, which means keep indefinitely.

```bash
costgrid retention show
costgrid retention set --calls 90 --events 365
costgrid retention run             # apply now instead of waiting for the daily run
```

The gateway applies the policy once a day. It **never** deletes the audit log,
even when an audit window is set: a job that erases evidence on a timer is
indistinguishable from someone erasing evidence, and a retention setting would
be a plausible way to do exactly that. Removing audit history takes
`costgrid audit purge --before <date> --confirm`, run by a person, and it
writes a record of itself into the chain it is cutting. An audit window may be
zero or at least 365 days; anything shorter is not an audit trail.

For a deletion request:

```bash
costgrid erase <organisation-id> --confirm
```

That removes everything belonging to one organisation, including its audit log,
because an audit trail describing an organisation is data about that
organisation. It prints what went, per table, which is usually what closes the
request. It cannot be undone.

## What is deliberately not built

**No payment processor.** Changing a plan records the intent; nobody's card is
charged. `GET /console/:tenant/billing` returns the invoice basis: the flat
monthly fee, and beside it the customer's own metered AI spend and call count,
which are shown for context and never used to compute the charge. An operator
collects. Charging money automatically is a real-world action that belongs
behind an explicit, deliberate integration.

**SQLite, so one node. This is the biggest gap, and Postgres alone does not
close it.**

Two separate things get conflated here, so they are separated below.

*Postgres portability.* The schema is validated against a real PostgreSQL, not
reasoned about: `npm test` applies the generated DDL to PostgreSQL 18 (via
PGlite, which is Postgres compiled from the same C sources to WebAssembly),
writes production-scale values, and runs the money aggregates on SQLite and
Postgres over identical rows to check they agree exactly.

That found two real defects that static checking had missed. SQLite's `INTEGER`
is 64-bit and Postgres's is 32-bit, so every nanodollar and millisecond
timestamp needs `BIGINT` or it overflows at $2.15 of spend. And the checker
originally read only the migrations, so `strftime` in the analytics queries and
`PRAGMA`/`sqlite_master` in the retention code were reported as portable when
they are not.

*What remains, which is most of it.* The schema is one component. Still
outstanding: the driver is synchronous and `pg` is not, so every repository
method and every caller becomes async; parameter placeholders change from `?`
to `$1`; the `strftime` day-bucketing must be rewritten as
`to_char(to_timestamp(...))` and its day boundaries re-tested, because those
figures appear on customer statements; schema introspection needs
`information_schema`; connection pooling, transaction and locking behaviour,
error handling and backup procedures are all different. Calling the current
state "the schema half done" would be generous. **It is generated and validated
DDL, and the application-level port has not started.**

*Postgres is not high availability.* Even with the port finished, the result is
one application server talking to one database server, which is two single
points of failure rather than one. Actual HA additionally needs: more than one
gateway instance, which today is blocked by the in-process rate limiter below;
a shared store for that limiter; database replication with tested failover;
health checks that a load balancer acts on; a restore procedure somebody has
actually run against a real backup; and a documented recovery objective. None
of that exists.

So the honest position for a security review: one gateway instance, one disk,
no horizontal scale, no failover. Fine for a team. Not fine where losing that
machine is an incident, and it should not be sold as if it were.

**In-process rate limiting.** Each instance enforces its own counter, so the
effective limit is `plan limit x instances`. With one instance that is exact.
A multi-node deployment needs a shared counter.

**No email.** No verification, no password reset, no invitations. A user who
forgets their password needs an operator with database access. Adding a member
to an organisation is currently a server-side call, not a UI flow.

**No shared rate limiting across instances.** Covered above, and repeated here
because it is the one gap that gets worse rather than better as a deployment
grows.

Each of these is a real gap rather than a rough edge. They are listed here so
the decision to launch with them is made deliberately, and so a prospect asking
"can you scale?" or "what happens if I forget my password?" gets an honest
answer.
