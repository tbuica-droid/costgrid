import { LABEL_READ_CHARS, TASK_KINDS, type TaskKind } from "@costgrid/core";

/**
 * The local-model task labeller (v3, D7).
 *
 * A small sentence model on the customer's own machine reads the request in
 * memory and picks the nearest kind of task. The text never leaves the
 * process and is never stored; only the label is kept. It runs after the
 * answer has gone to the caller, so it adds no delay, and refines the label
 * the signals labeller gave before forwarding.
 *
 * The runtime (transformers.js with ONNX Runtime) is not bundled: it adds
 * about 470 MB, which is the owner's call (v3 progress file, question 2).
 * When it is installed, the model (all-MiniLM-L6-v2, about 23 MB) downloads
 * once into the app's data folder. When it is not, `loadLocalLabeller` says
 * so and the signals labeller carries on alone.
 */

export interface Embedder {
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** What each kind looks like, in words a sentence model can compare with. */
const DESCRIPTIONS: Readonly<Record<TaskKind, string>> = {
  answer: "Answer a customer's question briefly.",
  chat: "Continue a friendly conversation.",
  summarise: "Summarise this text into key points.",
  extract: "Extract these fields from the document as JSON.",
  classify: "Classify this message into one category.",
  write: "Write a draft email or article.",
  code: "Write or fix code in a programming language.",
  analyse: "Analyse and compare the options and explain why.",
  "agent-step": "Use the tool result to decide the next action.",
};

export const LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export class ModelLabeller {
  readonly #embedder: Embedder;
  #prototypes: Promise<number[][]> | undefined;

  constructor(embedder: Embedder) {
    this.#embedder = embedder;
  }

  /** The nearest kind to `text`; the first 4 KB is all it reads. */
  async label(text: string): Promise<TaskKind> {
    this.#prototypes ??= this.#embedder.embed(TASK_KINDS.map((k) => DESCRIPTIONS[k]));
    const [prototypes, [vector]] = await Promise.all([this.#prototypes, this.#embedder.embed([text.slice(0, LABEL_READ_CHARS)])]);
    let best: TaskKind = "answer";
    let score = -Infinity;
    TASK_KINDS.forEach((kind, i) => {
      const s = cosine(vector!, prototypes[i]!);
      if (s > score) {
        score = s;
        best = kind;
      }
    });
    return best;
  }
}

/**
 * Load the local labeller, or explain why not. Never throws: a missing
 * runtime or a failed download leaves the signals labeller in charge.
 */
export async function loadLocalLabeller(cacheDir: string): Promise<{ labeller?: ModelLabeller; reason?: string }> {
  try {
    // A variable specifier, so builds and installs without the runtime still work.
    const name = "@huggingface/transformers";
    const runtime = (await import(name)) as {
      env: { cacheDir: string; allowRemoteModels: boolean };
      pipeline: (task: string, model: string, opts: object) => Promise<(t: string[], o: object) => Promise<{ tolist(): number[][] }>>;
    };
    runtime.env.cacheDir = cacheDir;
    const extract = await runtime.pipeline("feature-extraction", LOCAL_MODEL, { dtype: "q8" });
    const embedder: Embedder = {
      embed: async (texts) => (await extract([...texts], { pooling: "mean", normalize: true })).tolist(),
    };
    return { labeller: new ModelLabeller(embedder) };
  } catch (error) {
    return {
      reason:
        error instanceof Error && /Cannot find (module|package)/.test(error.message)
          ? "the local model runtime is not installed; task labels come from simple signals"
          : `the local model could not be loaded (${error instanceof Error ? error.message : String(error)}); task labels come from simple signals`,
    };
  }
}
