import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { VERSION } from "./version.js";

/**
 * Prometheus metrics for the people running the gateway, at `/metrics`.
 *
 * Small and dependency-free on purpose: a handful of counters and histograms
 * in the text format every scraper reads. Labels are route patterns
 * ("/console/:tenantId/limits"), never raw URLs or tenant ids, so the number
 * of series stays fixed however many customers there are.
 *
 * The SLI that matters most is `costgrid_preforward_seconds`: the time from a
 * call arriving to it being sent on to the provider. That is the latency
 * CostGrid adds; everything after it is the provider's.
 */

const BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

class Histogram {
  readonly #series = new Map<string, { counts: number[]; sum: number; count: number }>();

  observe(labels: string, seconds: number): void {
    let s = this.#series.get(labels);
    if (s === undefined) {
      s = { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.#series.set(labels, s);
    }
    for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]!) s.counts[i]!++;
    s.sum += seconds;
    s.count++;
  }

  render(name: string): string[] {
    const lines: string[] = [];
    for (const [labels, s] of this.#series) {
      const sep = labels === "" ? "" : ",";
      BUCKETS.forEach((b, i) => lines.push(`${name}_bucket{${labels}${sep}le="${b}"} ${s.counts[i]}`));
      lines.push(`${name}_bucket{${labels}${sep}le="+Inf"} ${s.count}`);
      lines.push(`${name}_sum${labels === "" ? "" : `{${labels}}`} ${s.sum}`);
      lines.push(`${name}_count${labels === "" ? "" : `{${labels}}`} ${s.count}`);
    }
    return lines;
  }
}

class Counter {
  readonly #series = new Map<string, number>();
  inc(labels = "", by = 1): void {
    this.#series.set(labels, (this.#series.get(labels) ?? 0) + by);
  }
  render(name: string): string[] {
    return [...this.#series].map(([labels, v]) => `${name}${labels === "" ? "" : `{${labels}}`} ${v}`);
  }
}

const quote = (v: string): string => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

export class Metrics {
  readonly requests = new Counter();
  readonly duration = new Histogram();
  readonly preforward = new Histogram();
  readonly upstreamErrors = new Counter();
  readonly meteringFailures = new Counter();
  readonly jobFailures = new Counter();
  readonly #started = Date.now();

  /** A finished request, labelled by route pattern and status class. */
  request(route: string, method: string, status: number, seconds: number): void {
    const labels = `method=${quote(method)},route=${quote(route)},status=${quote(`${Math.floor(status / 100)}xx`)}`;
    this.requests.inc(labels);
    this.duration.observe(`route=${quote(route)}`, seconds);
  }

  /** How long CostGrid took before handing a call to the provider. */
  forwarded(provider: string, seconds: number): void {
    this.preforward.observe(`provider=${quote(provider)}`, seconds);
  }

  upstreamError(provider: string, kind: "timeout" | "network" | "5xx"): void {
    this.upstreamErrors.inc(`provider=${quote(provider)},kind=${quote(kind)}`);
  }

  jobFailed(job: string): void {
    this.jobFailures.inc(`job=${quote(job)}`);
  }

  render(): string {
    const memory = process.memoryUsage();
    const out = [
      "# HELP costgrid_build_info The running version.",
      "# TYPE costgrid_build_info gauge",
      `costgrid_build_info{version=${quote(VERSION)}} 1`,
      "# HELP costgrid_uptime_seconds Seconds since the gateway started.",
      "# TYPE costgrid_uptime_seconds gauge",
      `costgrid_uptime_seconds ${(Date.now() - this.#started) / 1000}`,
      "# HELP costgrid_resident_memory_bytes Resident memory of the process.",
      "# TYPE costgrid_resident_memory_bytes gauge",
      `costgrid_resident_memory_bytes ${memory.rss}`,
      "# HELP costgrid_heap_used_bytes V8 heap in use.",
      "# TYPE costgrid_heap_used_bytes gauge",
      `costgrid_heap_used_bytes ${memory.heapUsed}`,
      "# HELP costgrid_http_requests_total Requests answered, by route pattern and status class.",
      "# TYPE costgrid_http_requests_total counter",
      ...this.requests.render("costgrid_http_requests_total"),
      "# HELP costgrid_http_request_duration_seconds Time to answer, by route pattern (streams: until the last byte).",
      "# TYPE costgrid_http_request_duration_seconds histogram",
      ...this.duration.render("costgrid_http_request_duration_seconds"),
      "# HELP costgrid_preforward_seconds Latency CostGrid adds: arrival to forwarding a call to the provider.",
      "# TYPE costgrid_preforward_seconds histogram",
      ...this.preforward.render("costgrid_preforward_seconds"),
      "# HELP costgrid_upstream_errors_total Provider calls that failed: timeout, network, or a 5xx.",
      "# TYPE costgrid_upstream_errors_total counter",
      ...this.upstreamErrors.render("costgrid_upstream_errors_total"),
      "# HELP costgrid_metering_failures_total Calls served but not recorded. Non-zero means figures are understated.",
      "# TYPE costgrid_metering_failures_total counter",
      ...this.meteringFailures.render("costgrid_metering_failures_total"),
      "# HELP costgrid_job_failures_total Background job runs that failed, by job.",
      "# TYPE costgrid_job_failures_total counter",
      ...this.jobFailures.render("costgrid_job_failures_total"),
    ];
    return `${out.join("\n")}\n`;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function tokenMatches(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Counts every request, and serves `/metrics`.
 *
 * Who may read it: with `COSTGRID_METRICS_TOKEN` set, whoever sends it as a
 * bearer token. Without one, only this machine, and never in hosted mode,
 * where "this machine" may be a load balancer relaying the internet.
 */
export function registerMetrics(
  app: FastifyInstance,
  metrics: Metrics,
  access: { token: string | undefined; hosted: boolean },
): void {
  app.addHook("onRequest", async (request, reply) => {
    const started = process.hrtime.bigint();
    // On the raw response so streamed answers, written outside Fastify's reply
    // cycle, are counted too, and timed to their last byte.
    reply.raw.once("finish", () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = request.routeOptions.url ?? "unmatched";
      metrics.request(route, request.method, reply.raw.statusCode, seconds);
    });
  });

  app.get("/metrics", async (request, reply) => {
    const allowed =
      access.token !== undefined ? tokenMatches(request, access.token) : !access.hosted && LOOPBACK.has(request.socket.remoteAddress ?? "");
    if (!allowed) return reply.code(404).send({ error: "not found" });
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
  });
}
