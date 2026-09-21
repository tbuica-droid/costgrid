import {
  Anchors,
  type AuditActor,
  AuditLog,
  type Db,
  generateAnchorKeys,
  describeVerification,
  MIN_AUDIT_DAYS,
  Retention,
} from "@costgrid/db";

/**
 * The commands that answer a security review: the audit log, data retention
 * and deletion.
 *
 * Written for whoever has to fill in the questionnaire rather than for whoever
 * wrote the software. Every command prints what it did in a sentence somebody
 * can paste into a form, because that is what these are actually used for.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Who a command-line change is attributed to.
 *
 * The shell user, because that is the only identity available here and naming
 * it honestly is better than recording every self-hosted change as "system".
 * It is not proof of identity, and it is not offered as any: someone with
 * shell access can set USER to anything. What it gives an auditor is the
 * account the change came through, which is usually the thread worth pulling.
 */
export function cliActor(): AuditActor {
  return { kind: "user", id: "cli", label: `cli:${process.env["USER"] ?? "unknown"}` };
}

/**
 * Record a change made from the command line.
 *
 * Self-hosted deployments have no console, so without this the audit log would
 * be empty on exactly the installations that were sold an audit log. Failing
 * to record must never fail the command that was already carried out: a
 * missing entry shows up as a gap, which is a finding, whereas a command that
 * half-happened is a corruption.
 */
export function recordCli(
  db: Db,
  tenantId: string,
  action: string,
  subject: string,
  detail: Record<string, string | number | boolean | null> = {},
): void {
  try {
    new AuditLog(db).record(tenantId, { actor: cliActor(), action, subject, detail });
  } catch (error) {
    console.error(
      `costgrid: warning, this change was made but could not be recorded in the audit log: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function fail(message: string): never {
  console.error(`costgrid: ${message}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function when(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

/** `costgrid audit [verify|head|list]` */
export function auditCommand(db: Db, tenantId: string, argv: string[]): void {
  const audit = new AuditLog(db);
  const sub = argv[1] ?? "list";

  if (sub === "head") {
    const head = audit.head(tenantId);
    console.log(`Entries recorded: ${head.seq}`);
    console.log(`Head hash:        ${head.hash}`);
    console.log("");
    // The instruction matters more than the value. A hash nobody wrote down
    // proves nothing later, and this is the moment somebody might.
    console.log("Copy that hash somewhere CostGrid cannot reach: an email to");
    console.log("whoever owns the audit, a ticket, a board minute. It commits to");
    console.log("every entry above. If any of them is ever changed or removed,");
    console.log("the hash will no longer match and you will be able to prove it.");
    return;
  }

  if (sub === "verify") {
    const result = audit.verify(tenantId);
    console.log(describeVerification(result));
    console.log("");
    console.log(`Checked at: ${when(result.checkedAt)}`);
    // Only printed when it means something. A head hash from a chain that
    // does not verify is not a fingerprint of anything worth recording.
    if (result.intact) console.log(`Head hash:  ${result.head}`);
    if (!result.intact) process.exit(2);
    return;
  }

  if (sub === "list") {
    const days = Number(flag(argv, "days") ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      fail(`--days must be a whole number from 1 to 3650, got ${days}`);
    }
    const action = flag(argv, "action");
    const entries = audit.list(tenantId, {
      from: Date.now() - days * DAY_MS,
      ...(action === undefined ? {} : { action }),
      limit: Number(flag(argv, "limit") ?? 100),
    });

    if (entries.length === 0) {
      console.log(`Nothing recorded in the last ${days} days.`);
      return;
    }

    const count = entries.length === 1 ? "1 entry" : `${entries.length} entries`;
    console.log(`COSTGRID AUDIT · last ${days} days · ${count}`);
    console.log("");
    for (const entry of entries.reverse()) {
      const detail = Object.entries(entry.detail)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      console.log(
        `${String(entry.seq).padStart(5)}  ${when(entry.occurredAt)}  ${entry.action.padEnd(24)} ` +
          `${entry.subject.padEnd(28)} ${entry.actor.label}${detail === "" ? "" : `  (${detail})`}`,
      );
    }
    return;
  }

  if (sub === "purge") {
    // Deliberately awkward. This is the one command in the product that
    // destroys evidence, and it should feel like it.
    const before = flag(argv, "before");
    if (before === undefined) {
      fail(
        'audit purge needs --before YYYY-MM-DD, and --confirm. It deletes audit history, which is the one thing here that cannot be reconstructed.',
      );
    }
    if (!argv.includes("--confirm")) fail("add --confirm to actually delete audit history");

    const cutoff = Date.parse(`${before}T00:00:00Z`);
    if (Number.isNaN(cutoff)) fail(`--before must be a date like 2026-01-31, got ${before}`);

    const removed = new AuditLog(db).purgeBefore(tenantId, cutoff, cliActor());
    console.log(`Removed ${removed} entries older than ${before}.`);
    console.log("");
    console.log("A record of this deletion was written into the log itself, with the");
    console.log("hash it was anchored to. Entries before that point can no longer be");
    console.log("verified by hash. Everything after it still can.");
    return;
  }

  if (sub === "keys") {
    // Printed once, to be copied. The private half stays here; the public half
    // goes to whoever receives the anchors, and is not a secret.
    const keys = generateAnchorKeys();
    console.log("Give the PUBLIC key to whoever receives your anchors.");
    console.log("Keep the PRIVATE key on this machine, in COSTGRID_ANCHOR_KEY.");
    console.log("");
    console.log("--- public, safe to share ---");
    console.log(keys.publicKey.trim());
    console.log("");
    console.log("--- private, treat as a credential ---");
    console.log(keys.privateKey.trim());
    console.log("");
    console.log("With only the public key, a receiver can prove an anchor came from this");
    console.log("CostGrid and has not been altered. They cannot forge one, which is why");
    console.log("this is a signature rather than a shared password.");
    return;
  }

  if (sub === "anchors") {
    const anchors = new Anchors(db);
    const recent = anchors.recent(tenantId, 20);
    if (recent.length === 0) {
      console.log("No anchors yet.");
      console.log("");
      console.log("Without them, the fingerprint of your audit log exists only on this");
      console.log("machine, so anyone who can change the log can change the fingerprint");
      console.log("with it. Set COSTGRID_ANCHOR_URL and COSTGRID_ANCHOR_KEY to send it");
      console.log('somewhere else. Generate a key with "costgrid audit keys".');
      return;
    }

    const pending = anchors.undelivered(tenantId, 1000);
    console.log(`COSTGRID AUDIT ANCHORS · ${recent.length} most recent`);
    console.log("");
    for (const a of recent) {
      const state = a.deliveredAt === undefined ? `UNDELIVERED (${a.attempts} tries)` : "delivered";
      console.log(
        `  #${String(a.payload.anchorNo).padStart(5)}  ${a.payload.at.slice(0, 19).replace("T", " ")}  ` +
          `entries ${String(a.payload.auditSeq).padStart(6)}  ${state}`,
      );
      if (a.lastError !== undefined) console.log(`          last error: ${a.lastError}`);
    }
    console.log("");
    if (pending.length > 0) {
      console.log(`${pending.length} anchor(s) never reached the receiver.`);
      console.log("Until they do, there is a gap in the archive, and a gap is exactly what");
      console.log("somebody covering their tracks would leave. Fix the destination.");
    } else {
      console.log("Every anchor reached the receiver. They hold an independent copy of");
      console.log("your audit log's fingerprint, so a change here can be proved there.");
    }
    return;
  }

  fail(
    `unknown audit subcommand ${JSON.stringify(sub)}. ` +
      "Expected list, verify, head, keys, anchors or purge.",
  );
}

/** `costgrid retention [show|set|run]` */
export function retentionCommand(db: Db, tenantId: string, argv: string[]): void {
  const retention = new Retention(db);
  const sub = argv[1] ?? "show";

  const describe = (days: number): string =>
    days === 0 ? "kept indefinitely" : `${days} days`;

  if (sub === "show") {
    const settings = retention.settingsOf(tenantId);
    console.log("COSTGRID DATA RETENTION");
    console.log("");
    console.log(`  Detail of every call     ${describe(settings.callDays)}`);
    console.log(`  Record of rules firing   ${describe(settings.eventDays)}`);
    console.log(`  Audit log                ${describe(settings.auditDays)}`);
    console.log("");
    if (settings.updatedAt === 0) {
      console.log("Nothing has been set, so nothing is ever deleted. That is the default.");
    } else {
      console.log(`Last changed ${when(settings.updatedAt)}.`);
    }
    console.log("");
    console.log('Change it with: costgrid retention set --calls 90 --events 365');
    return;
  }

  if (sub === "set") {
    const read = (name: string): number | undefined => {
      const raw = flag(argv, name);
      if (raw === undefined) return undefined;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        fail(`--${name} must be a whole number of days, or 0 to keep everything`);
      }
      return value;
    };

    try {
      const saved = retention.set(
        tenantId,
        { callDays: read("calls"), eventDays: read("events"), auditDays: read("audit") },
        cliActor(),
      );
      console.log("Saved.");
      console.log("");
      console.log(`  Detail of every call     ${describe(saved.callDays)}`);
      console.log(`  Record of rules firing   ${describe(saved.eventDays)}`);
      console.log(`  Audit log                ${describe(saved.auditDays)}`);
      console.log("");
      console.log("Nothing has been deleted yet. The gateway applies this once a day,");
      console.log('or run "costgrid retention run" to apply it now.');
      if (saved.auditDays !== 0) {
        console.log("");
        console.log(`The audit log is never deleted automatically, even with a window set.`);
        console.log('Removing audit history takes "costgrid audit purge", run by a person.');
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "could not save");
    }
    return;
  }

  if (sub === "run") {
    const result = retention.purge(tenantId);
    if (result.total === 0) {
      console.log("Nothing had aged out. Nothing was deleted.");
      return;
    }
    console.log(`Deleted ${result.total} rows:`);
    console.log("");
    console.log(`  Calls                 ${result.calls}`);
    console.log(`  Tool invocations      ${result.toolInvocations}`);
    console.log(`  Run outcomes          ${result.outcomes}`);
    console.log(`  Imported history      ${result.importedUsage}`);
    console.log(`  Rule firings          ${result.violations}`);
    console.log("");
    console.log("This is recorded in the audit log. It cannot be undone.");
    return;
  }

  fail(
    `unknown retention subcommand ${JSON.stringify(sub)}. Expected show, set or run. ` +
      `An audit window must be 0 or at least ${MIN_AUDIT_DAYS} days.`,
  );
}

/** `costgrid erase --confirm <tenant-id>` */
export function eraseCommand(db: Db, argv: string[]): void {
  const target = argv.find((arg, index) => index > 0 && !arg.startsWith("--"));
  if (target === undefined) fail("erase needs the organisation id to delete");
  if (!argv.includes("--confirm")) {
    fail(
      `this permanently deletes everything belonging to "${target}", including its audit log. ` +
        "Nothing is recoverable afterwards. Add --confirm if that is what you want.",
    );
  }

  const result = new Retention(db).eraseTenant(target);
  if (result.total === 0) {
    console.log(`Nothing was stored for "${target}".`);
    return;
  }

  console.log(`Deleted everything belonging to "${target}": ${result.total} rows.`);
  console.log("");
  for (const [table, count] of Object.entries(result.tables).sort()) {
    console.log(`  ${table.padEnd(24)} ${count}`);
  }
  console.log("");
  // An erasure request is usually closed by telling somebody it was done.
  console.log(`Completed ${when(result.erasedAt)}. Keep this output: it is the`);
  console.log("confirmation that the deletion happened, and no record of it remains");
  console.log("inside CostGrid, because that record would itself be their data.");
}
