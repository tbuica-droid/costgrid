/**
 * The words on the Connect step: what each provider calls things, where the
 * keys and exports live, and who is allowed to make them.
 *
 * Kept apart from console-connect.js so the copy can be checked and changed
 * without reading the code that lays it out. Everything here is plain text;
 * the screen escapes it before it reaches the page.
 *
 * CHECK BEFORE RELEASE: every URL below and every menu name in the steps was
 * written from the providers' public documentation, not from a real account.
 * Open each link signed in as an owner and follow each list of steps once
 * before shipping; the providers move these pages without notice.
 */

export const PROVIDERS = [
  {
    id: "anthropic",
    name: "Claude (Anthropic)",
    short: "Claude",
    adminKey: {
      url: "https://platform.claude.com/settings/admin-keys",
      linkText: "Admin keys in the Claude Console",
      steps: [
        "Sign in to the Claude Console as an admin of your organisation.",
        "Open Settings, then Admin keys.",
        "Choose Create admin key, name it CostGrid, and copy it.",
        "Paste it below and choose when CostGrid should stop using it.",
      ],
      warning:
        "Claude admin keys can also change your account settings, not just read usage. " +
        "CostGrid only reads usage. Give the key an expiry date. An admin key starts with " +
        "sk-ant-admin; an ordinary API key won't work. Personal Claude accounts can't create " +
        "admin keys: use the Usage file tab instead.",
      shotCaption: "Screenshot to come: the Admin keys page in the Claude Console.",
    },
    usageFile: {
      url: "https://platform.claude.com/usage",
      linkText: "Usage in the Claude Console",
      steps: [
        "Sign in to the Claude Console.",
        "Open Usage.",
        "Choose Export and save the file. Its name starts with claude_api_tokens.",
        "Drop the file here, or choose it.",
      ],
      who: "Anyone with the Developer, Billing or Admin role can export it. No admin key is needed.",
      costFileHint:
        "That file lists costs, not usage. In the Claude Console, open Usage and export the usage file instead.",
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    short: "OpenAI",
    adminKey: {
      url: "https://platform.openai.com/settings/organization/admin-keys",
      linkText: "Admin keys in the OpenAI platform",
      steps: [
        "Sign in to the OpenAI platform as the owner of your organisation.",
        "Open Settings, then Organization, then Admin keys.",
        "Create a new admin key, name it CostGrid, and copy it.",
        "Paste it below and choose when CostGrid should stop using it.",
      ],
      warning:
        "Only the account owner can create an admin key. It starts with sk-admin-; an " +
        "ordinary project key (sk-proj-) won't work.",
      shotCaption: "Screenshot to come: the Admin keys page in the OpenAI platform.",
    },
    usageFile: {
      url: "https://platform.openai.com/usage",
      linkText: "Usage in the OpenAI platform",
      steps: [
        "Sign in to the OpenAI platform.",
        "Open Usage.",
        "Choose Export, then Activity, and save the file.",
        "Drop the file here, or choose it.",
      ],
      who:
        "The account owner, or someone they gave the Usage permission, can export it. " +
        "No admin key is needed.",
      costFileHint:
        "That file lists costs, not usage. On the Usage page, choose Export, then Activity, instead.",
    },
  },
];

/** When CostGrid should stop using a stored admin key. */
export const EXPIRY_OPTIONS = [
  { value: "3h", label: "3 hours", ms: 3 * 3600_000 },
  { value: "1d", label: "1 day", ms: 86_400_000 },
  { value: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { value: "30d", label: "30 days", ms: 30 * 86_400_000 },
  { value: "date", label: "A date I choose" },
  { value: "never", label: "Never" },
];
export const DEFAULT_EXPIRY = "30d";

export const COPY = {
  stepIntro:
    "Connect one account or both, whichever way suits you. An admin key lets CostGrid check for new " +
    "usage every few hours. A usage file needs no special access, and you upload a new one when you " +
    "want fresher numbers. Or ask whoever set up your AI to do it.",
  noStore:
    "This computer cannot keep keys safely, so an admin key is used once for the import and then " +
    "forgotten. To update your numbers later, connect again or upload a usage file.",
  keyLabel: "Admin key",
  expiryLabel: "Stop using the key after",
  dateLabel: "The last day CostGrid may use it",
  connectButton: "Connect and import 90 days",
  connecting: "Importing, this can take a minute…",
  storedWithExpiry: "Key kept in your Mac's Keychain. We'll remind you before it expires.",
  storedNoExpiry: "Key kept in your Mac's Keychain.",
  notStored: "Key used once and not kept on this computer.",
  dropTitle: "Drop the usage file here",
  chooseFile: "Choose a file",
  developerNote:
    "Never send a key by email. Ask them to give it to you in person or paste it in themselves.",
  developerIntro:
    "A message you can send to whoever set up your AI. It asks for the usage file or an admin key " +
    "with an expiry date. It contains no keys and no link to this computer.",
};

/** The one-line note shown before a usage file is sent. */
export const replacesNote = (short) => `This replaces ${short} usage for the days the file covers.`;
