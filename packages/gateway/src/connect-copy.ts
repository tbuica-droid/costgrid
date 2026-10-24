/**
 * The message an owner sends to whoever set up their AI, asking for what
 * CostGrid needs to show the costs.
 *
 * Its own file because it is words, not logic, and because of what it must
 * never contain: a key, a token, or a link to the owner's computer. The
 * owner copies it into an email, so anything in it goes wherever that email
 * goes. It asks for a usage file first, since that needs no admin rights, and
 * for an admin key only with an expiry and only handed over in person.
 *
 * Also here: what the owner is told when a key cannot be used, in the same
 * plain words wherever the refusal comes from.
 */

export type MessageAudience = "anthropic" | "openai" | "both";

export function isMessageAudience(value: unknown): value is MessageAudience {
  return value === "anthropic" || value === "openai" || value === "both";
}

interface ProviderText {
  readonly name: string;
  readonly file: string;
  readonly key: string;
}

const TEXT: Record<"anthropic" | "openai", ProviderText> = {
  anthropic: {
    name: "Claude (Anthropic)",
    file:
      "In the Claude Console, open Usage and use Export to download the token usage file " +
      "(a CSV named claude_api_tokens_…) for the last 90 days.",
    key:
      "In the Claude Console, under Settings → Admin keys, create an admin key. A Claude " +
      "admin key can also change settings, so please delete it once the agreed date has passed.",
  },
  openai: {
    name: "OpenAI",
    file:
      "On the OpenAI Platform, open Usage and use Export to download the activity file " +
      "(a CSV named completions_usage_…) for the last 90 days.",
    key:
      "On the OpenAI Platform, under Settings → Organization → Admin keys, create an " +
      "admin key, and delete it once the agreed date has passed.",
  },
};

export function developerMessage(audience: MessageAudience): { subject: string; body: string } {
  const providers = audience === "both" ? (["anthropic", "openai"] as const) : ([audience] as const);
  const names = providers.map((p) => TEXT[p].name).join(" and ");

  const fileSteps = providers.map((p) => `- ${TEXT[p].file}`).join("\n");
  const keySteps = providers.map((p) => `- ${TEXT[p].key}`).join("\n");

  const body = [
    "Hi,",
    "",
    `I'm using CostGrid on my computer to see what our ${names} usage costs, and I need ` +
      "one of the following from you. Whichever is easier is fine.",
    "",
    "Option 1, the usage file (no admin rights needed):",
    fileSteps,
    "Then send me the file. It contains token counts per day and model, not the content of " +
      "any conversation.",
    "",
    "Option 2, an admin key that reads usage:",
    keySteps,
    "Let's agree on a date when it stops being used, as soon as is practical. Please hand " +
      "the key to me in person, not by email or chat. I'll paste it into CostGrid myself with " +
      "that date: CostGrid keeps it in this computer's keychain and stops using it on that date.",
    "",
    "Thank you!",
  ].join("\n");

  return { subject: `Usage export for ${names}, please`, body };
}

// ------------------------------------------------- connecting, in plain words

type KeyProvider = "anthropic" | "openai";

const NAME: Record<KeyProvider, string> = { anthropic: "Claude", openai: "OpenAI" };

/** Only Claude and OpenAI keys connect; anything else is told nothing specific. */
const isKeyProvider = (provider: string): provider is KeyProvider => provider in NAME;

/** What an owner needs, said the same way whether the key was refused here or by the provider. */
const NEEDS: Record<KeyProvider, string> = {
  anthropic:
    "CostGrid needs a Claude admin key (it starts with sk-ant-admin), from the Claude Console " +
    "under Settings → Admin keys. Personal Claude accounts can't create admin keys; use the " +
    "Usage file tab instead.",
  openai:
    "CostGrid needs an OpenAI admin key (it starts with sk-admin-), from the OpenAI Platform " +
    "under Settings → Organization → Admin keys. Only an owner of the organisation can create " +
    "one; if that isn't you, use the Usage file tab or Ask my developer.",
};

/** Ordinary keys: they call models, but can never read an organisation's usage. */
// Only OpenAI's are refused on sight. Anthropic says an organisation-scoped
// API key can also read usage, and its keys do not show which kind they are,
// so a Claude key is left for Anthropic to judge.
const ORDINARY: Partial<Record<KeyProvider, RegExp>> = { openai: /^sk-(proj|svcacct|None)-/ };
const OTHER: Record<KeyProvider, RegExp> = {
  anthropic: /^sk-(proj|svcacct|None|admin)-/,
  openai: /^sk-ant-/,
};

/**
 * Why this cannot be an admin key for this provider, or undefined when it
 * may be one. Checked before anything is sent, so a key pasted on the wrong
 * card, or one that can only call models, never leaves this computer.
 */
export function notAnAdminKey(provider: string, key: string): string | undefined {
  if (!isKeyProvider(provider)) return undefined;
  const other: KeyProvider = provider === "anthropic" ? "openai" : "anthropic";
  if (OTHER[provider].test(key)) {
    const article = other === "openai" ? "an" : "a";
    return `This looks like ${article} ${NAME[other]} key. Paste it on the ${NAME[other]} card instead.`;
  }
  if (ORDINARY[provider]?.test(key)) {
    return `This is an ordinary ${NAME[provider]} API key, which can't read usage. ${NEEDS[provider]}`;
  }
  return undefined;
}

/**
 * A failed import, explained. Refusals and outages get a sentence an owner
 * can act on; anything else keeps the provider's own words, already cleaned
 * of any key by `safeErrorMessage`.
 */
export function explainImportError(provider: string, message: string): string {
  if (!isKeyProvider(provider)) return `The import failed: ${message}`;
  const name = NAME[provider];
  const status = /^provider returned (\d{3})\b/.exec(message)?.[1];
  if (status === "401") return `${name} didn't accept this key for reading usage. ${NEEDS[provider]}`;
  if (status === "403") return `This ${name} key isn't allowed to read usage. ${NEEDS[provider]}`;
  if (status === "429") return `${name} asked CostGrid to slow down. Try again in a few minutes.`;
  if (status !== undefined && status.startsWith("5")) {
    return `${name} had a problem on its side (${status}). Try again in a few minutes.`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
    return `CostGrid couldn't reach ${name}. Check this computer's internet connection and try again.`;
  }
  return `The import failed: ${message}`;
}
