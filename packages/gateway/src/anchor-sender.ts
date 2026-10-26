import { Anchors, type Anchor } from "@costgrid/db";
import type { FastifyBaseLogger } from "fastify";

/**
 * Sending anchors to a system CostGrid does not control.
 *
 * Deliberately dull. It posts JSON to a URL, which is what every log
 * collector, SIEM and auditor endpoint already accepts, and it retries
 * anything that did not arrive. There is no queue and no broker: an anchor is
 * one small message an hour, and machinery in front of that would be more
 * moving parts than the thing it carries.
 *
 * Two behaviours are load-bearing rather than incidental.
 *
 * **It sends even when nothing changed.** A receiver cannot distinguish a
 * quiet week from a switched-off sender unless the quiet week still produces
 * a heartbeat. Absence is the signal that catches somebody who disabled
 * anchoring before tampering, and absence only means something if presence
 * was regular.
 *
 * **It never gives up on an undelivered anchor.** A normal sender drops a
 * message after some retries. Here the undelivered ones are the interesting
 * population: they are the gap a receiver will eventually ask about, so they
 * stay in the table and keep being offered.
 */

export interface AnchorSenderOptions {
  readonly url: string;
  readonly privateKey: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly log: FastifyBaseLogger;
}

/** Anchors older than this are still retried, but no longer block new ones. */
const MAX_BACKLOG_PER_RUN = 25;

export class AnchorSender {
  readonly #anchors: Anchors;
  readonly #options: AnchorSenderOptions;

  constructor(anchors: Anchors, options: AnchorSenderOptions) {
    this.#anchors = anchors;
    this.#options = options;
  }

  /**
   * Create this period's anchor for every tenant, then flush the backlog.
   *
   * Creation happens first and unconditionally. If the receiver is down, the
   * anchor still exists locally with its sequence number reserved, so the
   * stream has no hole in it once delivery catches up.
   */
  async run(now = Date.now()): Promise<{ created: number; delivered: number; failed: number }> {
    const { log } = this.#options;
    let created = 0;
    let delivered = 0;
    let failed = 0;

    for (const tenantId of this.#anchors.tenantsWithHistory()) {
      try {
        this.#anchors.create(tenantId, this.#options.privateKey, now);
        created++;
      } catch (error) {
        // A signing failure is a misconfiguration, not a transient fault, and
        // it means anchoring is silently not happening. Say so loudly.
        log.error({ err: error, tenantId }, "could not create an audit anchor");
        continue;
      }

      for (const pending of this.#anchors.undelivered(tenantId, MAX_BACKLOG_PER_RUN)) {
        const anchor: Anchor = {
          payload: pending.payload,
          signature: pending.signature,
          hash: pending.hash,
        };
        const sent = await this.#deliver(anchor);
        if (sent.ok) {
          this.#anchors.markDelivered(tenantId, anchor.payload.anchorNo, Date.now());
          delivered++;
        } else {
          this.#anchors.markFailed(tenantId, anchor.payload.anchorNo, sent.error);
          failed++;
          // Stop at the first failure for this tenant: the receiver is down,
          // and hammering it with the rest of the backlog helps nobody.
          break;
        }
      }
    }

    if (failed > 0) {
      log.warn(
        { created, delivered, failed },
        "audit anchors could not be delivered; the archive will show a gap until they are",
      );
    }
    return { created, delivered, failed };
  }

  async #deliver(anchor: Anchor): Promise<{ ok: true } | { ok: false; error: string }> {
    const doFetch = this.#options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(this.#options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Lets a collector route or filter without parsing the body.
          "x-costgrid-anchor": String(anchor.payload.anchorNo),
        },
        body: JSON.stringify(anchor),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { ok: false, error: `receiver returned ${response.status}` };
      return { ok: true };
    } catch (error) {
      // The receiver's address can carry a token, so it never reaches the stored error.
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message.split(this.#options.url).join("[receiver address]") };
    }
  }
}
