/**
 * The words on setup step 3, "Match each key to an agent": what an agent is,
 * how costs are labelled on an agent card, and how to split a key that several
 * agents share.
 *
 * Kept apart from console-agents.js so the copy can be checked and changed
 * without reading the code that lays it out. Everything here is plain text;
 * the screen escapes it before it reaches the page.
 *
 * Rules for this copy: never ask for a key, never promise savings, and never
 * say anything happens instantly. Spending from before a split is not divided.
 *
 * CHECK BEFORE RELEASE: every URL below and every menu name in the split
 * guides was written from the providers' public documentation, not from a real
 * account. Open each link signed in as an owner and follow each list of steps
 * once before shipping; the providers move these pages without notice.
 */

export const PROVIDER_NAMES = { anthropic: "Claude", openai: "OpenAI" };
export const KINDS = { key: "API key", workspace: "Workspace", project: "Project", account: "Whole account" };
/** What each provider calls the group a key belongs to. */
export const PARENT_NAMES = { anthropic: "Workspace", openai: "Project" };

export const COPY = {
  intro:
    'An agent is one job your AI does, for example "Support bot" or "Invoice reader". Match each ' +
    "key, project or workspace to the agent that uses it, and say what the agent is for. Then " +
    "CostGrid can show what each job costs you.",
  empty: "Connect an account in step 2 and your keys, projects and workspaces appear here.",
  agentsTitle: "Your agents",
  noAgents: 'No agents yet. Choose "New agent…" next to a key below to make the first one.',
  unassignedTitle: "Not matched yet",
  unassignedNote: "Say which agent uses each of these. If several agents use the same key, say so.",
  sharedTitle: "Shared keys",
  sharedNote:
    "Several agents use each of these, so their cost cannot be told apart. It is shown here as " +
    "shared until each agent has its own key.",
  nameLabel: "Agent name",
  namePlaceholder: "For example: Support bot",
  purposeLegend: "What it is for",
  presetsMissing: "The list of purposes could not be loaded.",
  noSources: "No keys matched to this agent yet.",
  matched: "Matched by name: same key, seen on different dates.",
  notSameKey: "Not the same key",
  remove: "Remove",
  save: "Save",
  saved: "Saved",
  notSaved: "Not saved",
  chooseLabel: "Which agent uses it?",
  choosePlaceholder: "Choose…",
  newAgentOption: "New agent…",
  sharedOption: "Several agents use this key",
  notShared: "Not shared",
  linkProxyLabel: "Already sends traffic through CostGrid as…",
  linkProxyNone: "No, or I don't know",
  linkProxyNote: "Pick its code name if a developer already set this agent up to send traffic through CostGrid.",
  advanced: "Advanced",
  deleteAgent: "Delete agent",
  needName: "Give the agent a name.",
  needChoice: "Choose an agent, a new agent, or that several agents use it.",
  createdNotMatched: "The agent was made, but the key could not be matched to it:",
  alsoMatched: "The same key seen on different dates was matched to this agent too.",
  finish: "Finish and see my costs",
};

/** The developer note under "Advanced". The code name is inserted as <code> by the screen. */
export const codeNameBefore = "To send traffic through CostGrid as this agent, set the x-costgrid-agent header to";
export const codeNameAfter = ".";

export function confirmDelete(name, origin) {
  return origin === "proxy"
    ? `Delete the agent "${name}"? Its keys go back to "Not matched yet". CostGrid keeps its code name ` +
        "because traffic already uses it, but forgets its name and what it is for."
    : `Delete the agent "${name}"? Its keys go back to "Not matched yet". Spending already recorded stays.`;
}

const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export const sharedToSplit = (n) => `${plural(n, "shared key", "shared keys")} to split when you can`;
export const unmatchedLeft = (n) => `${plural(n, "key with spending needs", "keys with spending need")} an agent`;
export const purposeLeft = (n) => `${plural(n, "agent needs", "agents need")} a purpose`;

export const reportLine = (cost) => `Provider report, last 90 days: ${cost}`;
export const estimateNote = (part, all) =>
  all ? "all of it is an estimate from list prices" : `${part} of it is an estimate from list prices`;
export const meteredLine = (cost, calls) => `Measured by CostGrid: ${cost} (${plural(calls, "call", "calls")})`;
export const lastCall = (ago) => `last call ${ago}`;
export const seen = (range) => `Seen ${range}`;

// ------------------------------------------------------------ split guides

export const SPLIT = {
  title: "How to split a shared key",
  intro:
    "Claude and OpenAI cannot tell which agent used a shared key. To see each agent's cost, give " +
    "each agent its own key. CostGrid never needs the new keys themselves.",
  before: "Spending from before the split stays with the shared key. CostGrid does not divide it by guesswork.",
};

/**
 * One guide per provider. Each step is `{ text, link? }`; a link is shown
 * after the text as `linkText`.
 */
export const SPLIT_GUIDES = {
  anthropic: [
    {
      text:
        "Optional: give each agent its own workspace first. In the Claude Console open Settings, " +
        "then Workspaces, and create one per agent. Only admins can do this.",
      link: { url: "https://platform.claude.com/settings/workspaces", text: "Workspaces in the Claude Console" },
    },
    {
      text: "In the Claude Console open API keys and choose Create key. If you made a workspace for the agent, pick it.",
      link: { url: "https://platform.claude.com/settings/keys", text: "API keys in the Claude Console" },
    },
    { text: "Give the new key an expiry date." },
    { text: "Give the new key only to that agent. Whoever set up the agent changes the key there." },
    {
      text:
        "CostGrid shows the new key after its next check (within 6 hours with an admin key) or " +
        "when you upload the next usage file. Then match it to the agent here.",
    },
    { text: "When nothing uses the old shared key any more, switch it off in the Claude Console." },
  ],
  openai: [
    {
      text:
        "Create a project for each agent: open Settings, then Organization, then Projects. Only " +
        "owners can do this. One project per agent also lets you set a spending limit for that agent later.",
      link: { url: "https://platform.openai.com/settings/organization/projects", text: "Projects in the OpenAI platform" },
    },
    {
      text: "Open API keys, create a new secret key, and pick that agent's project for it.",
      link: { url: "https://platform.openai.com/api-keys", text: "API keys in the OpenAI platform" },
    },
    { text: "Give the new key only to that agent. Whoever set up the agent changes the key there." },
    {
      text:
        "CostGrid shows the new key after its next check (within 6 hours with an admin key) or " +
        "when you upload the next usage file. Then match it to the agent here.",
    },
    { text: "When nothing uses the old shared key any more, switch it off (revoke it) on the API keys page." },
  ],
};
