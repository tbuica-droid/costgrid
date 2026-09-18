import { describe, expect, it } from "vitest";
import { ask, unverifiedFigures, type AnalystConfig } from "../src/analyst.js";

const BRIEFING = [
  "Window: the last 30 days.",
  "Total spend: $106.81. The 30 days before that: $0.00.",
  "Spend by agent:",
  "  doc-summariser: $56.00 over 400 calls",
  "  ticket-classifier: $29.02 over 900 calls",
].join("\n");

function stub(reply: unknown, status = 200) {
  const seen: { url?: string; body?: string; headers?: Record<string, string> } = {};
  const impl = (async (url: unknown, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = String(init?.body);
    seen.headers = init?.headers as Record<string, string>;
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const openai = (text: string) => ({ choices: [{ message: { content: text } }] });
const anthropic = (text: string) => ({ content: [{ type: "text", text }] });

const CONFIG: AnalystConfig = {
  wire: "openai",
  apiKey: "k",
  model: "grok-test",
  baseUrl: "https://api.x.ai",
};

describe("the analyst", () => {
  it("answers from the briefing and reports the model", async () => {
    const { impl } = stub(openai("Most of it is doc-summariser, at $56.00."));
    const answer = await ask(CONFIG, BRIEFING, "where is the money going", impl);

    expect(answer.text).toContain("doc-summariser");
    expect(answer.model).toBe("grok-test");
    expect(answer.unverified).toHaveLength(0);
  });

  /*
   * The check that makes the feature safe to put in front of a customer. A
   * model that quotes a figure nobody gave it has invented it, and the reader
   * should not have to be the one who notices.
   */
  it("flags a figure that is not in the briefing", async () => {
    const { impl } = stub(openai("Spend rose to $999.99 last week."));
    const answer = await ask(CONFIG, BRIEFING, "what happened", impl);
    expect(answer.unverified).toEqual(["$999.99"]);
  });

  it("does not flag figures read straight off the data", async () => {
    const { impl } = stub(openai("It went from $0.00 to $106.81, driven by $56.00 of summarising."));
    const answer = await ask(CONFIG, BRIEFING, "what happened", impl);
    expect(answer.unverified).toHaveLength(0);
  });

  it("reports each invented figure once", async () => {
    const { impl } = stub(openai("$500.00 here, $500.00 again, and $12.34 besides."));
    const answer = await ask(CONFIG, BRIEFING, "?", impl);
    expect(answer.unverified).toEqual(["$500.00", "$12.34"]);
  });

  // ------------------------------------------------------------- the wires

  it("speaks xAI and anything else that uses OpenAI's shape", async () => {
    const { impl, seen } = stub(openai("fine"));
    await ask(CONFIG, BRIEFING, "q", impl);

    expect(seen.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(seen.headers?.["authorization"]).toBe("Bearer k");
    const body = JSON.parse(seen.body!);
    expect(body.model).toBe("grok-test");
    expect(body.messages[0].role).toBe("system");
    // The question and the briefing travel together, and nothing else does.
    expect(body.messages[1].content).toContain(BRIEFING);
    expect(body.messages[1].content).toContain("q");
  });

  it("speaks Anthropic's shape when told to", async () => {
    const { impl, seen } = stub(anthropic("fine"));
    const answer = await ask(
      { wire: "anthropic", apiKey: "k2", model: "claude-haiku-4-5" },
      BRIEFING,
      "q",
      impl,
    );

    expect(answer.text).toBe("fine");
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen.headers?.["x-api-key"]).toBe("k2");
    expect(seen.headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(seen.body!).system).toContain("business owner");
  });

  /*
   * The confidentiality claim, pinned. What leaves the network is the briefing
   * and the question, and the briefing is assembled somewhere a customer can
   * print in full. Anything that ever added a field here would fail this.
   */
  it("sends the briefing and the question, and carries nothing else", async () => {
    const { impl, seen } = stub(openai("fine"));
    await ask(CONFIG, BRIEFING, "why did it go up", impl);

    const body = JSON.parse(seen.body!);
    expect(Object.keys(body).sort()).toEqual(["max_completion_tokens", "messages", "model"]);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: expect.any(String) });
    expect(body.messages[1].content).toBe(
      `Briefing:\n\n${BRIEFING}\n\nQuestion: why did it go up`,
    );
  });

  it("marks an answer given on the trial key", async () => {
    const { impl } = stub(openai("fine"));
    const answer = await ask({ ...CONFIG, demo: true }, BRIEFING, "q", impl);
    expect(answer.demo).toBe(true);
  });

  // ------------------------------------------------------------- failures

  it("passes the vendor's own error through", async () => {
    const { impl } = stub({ error: { message: "insufficient credits" } }, 402);
    await expect(ask(CONFIG, BRIEFING, "q", impl)).rejects.toThrow(/402.*insufficient credits/);
  });

  it("refuses an empty answer rather than printing nothing", async () => {
    const { impl } = stub(openai(""));
    await expect(ask(CONFIG, BRIEFING, "q", impl)).rejects.toThrow(/empty/);
  });

  it("refuses a reply that is not JSON", async () => {
    const { impl } = stub("<html>gateway timeout</html>");
    await expect(ask(CONFIG, BRIEFING, "q", impl)).rejects.toThrow(/not JSON/);
  });
});

describe("checking figures against the data", () => {
  it("accepts a briefing with no figures at all", () => {
    expect(unverifiedFigures("nothing happened", "")).toEqual([]);
  });

  /*
   * The trap in a substring check, from both directions. A briefing figure
   * must vouch for an answer's figure only when they are the same figure.
   */
  it("compares whole figures, not substrings", () => {
    // The briefing's $10.00 sits inside the answer's $110.00 and must not
    // vouch for it.
    expect(unverifiedFigures("you spent $110.00", "you spent $10.00")).toEqual(["$110.00"]);
    // And the reverse: the briefing's $110.00 must not vouch for a bare $10.00.
    expect(unverifiedFigures("you spent $10.00", "you spent $110.00")).toEqual(["$10.00"]);
    // Trailing-zero variants were not read off a briefing that renders to two
    // decimal places.
    expect(unverifiedFigures("you spent $10.000", "totals $10.00")).toEqual(["$10.000"]);
  });

  it("handles thousands separators", () => {
    expect(unverifiedFigures("$1,240.50 this month", "total $1,240.50")).toEqual([]);
    expect(unverifiedFigures("$1,240.50 this month", "total $1240.50")).toEqual(["$1,240.50"]);
  });
});
