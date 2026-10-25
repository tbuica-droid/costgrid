# CostGrid: where we are, and what changed after the first outside feedback

Updated 24 October 2026.

## The road so far

| When | What |
|---|---|
| Late August | The research: the token cost model spreadsheet, the thesis page and the research dashboard, built on why AI bills rise while prices per token fall. |
| 5 to 12 September | The product core. A gateway that prices every AI request from the provider's own token counts and enforces budgets before the request is sent. A live dashboard, a price table of 53 models checked against the providers' published prices, OpenAI added alongside Anthropic, accounts for many organisations, a 90-day history import, routing to cheaper models, budgets that downgrade to a cheaper model instead of breaking, and a monthly statement. |
| 12 to 23 September | The website and trial. The product site, the live demo and a trial guide. The site moved to Vercel at costgrid.dev and was made to work on phones. Pricing became a flat rate instead of a share of the bill. A design system, and two rounds of redesign. |
| 17 to 21 September | Agent governance. Limits per agent run: spend, steps, and how many times agents can hand work to other agents. A map of which agent uses which tool. Tool rules an agent can't get around by delegating. CostGrid suggesting its own rules, and an autopilot with hard limits on what it may change. AWS Bedrock and Google Vertex. Negotiated rates. A report of when agents start behaving differently, including calls to tools they were never given. Latency measured at about 1.2 ms. An audit log anchored outside the machine it runs on. |
| 24 to 26 September | Accounts and the app. Website sign-in by email link, with the demo and downloads behind it. App screens for everything that used to need the command line: setup wizard, suggestions, behaviour changes, backup, audit anchors and account erase. The Mac app itself, with the master key in the Mac's keychain. The 90-day spend import on the setup screen. A fix so the app needs no compiler. A release pipeline to the public `costgrid-releases` repository, with the code repository made private. Version 1.0.1 published, downloaded from the website and confirmed working on your Mac. |
| 27 September | Plain-language website. Self-hosting, terminal commands and jargon removed. |
| 2 October | First outside feedback on the website, from a professional contact, below. |
| 3 October | Closing the gap between the twelve research sources and the product, at the end of this file. |
| 15 October | Licence switched to FSL-1.1-ALv2. A gap report compared the code with the version 2 direction (cost per successful job, desktop first, View and View and control) and checked what the OpenAI and Anthropic admin APIs allow. |
| 23 to 24 October | Version 2, round 1: the LCSO engine, a new look for the app and the website, and a rebuilt website. Details below. |

## What the feedback said

1. Without last summer's context, the page doesn't make clear what CostGrid does or what makes it different. It pointed at the "Point your software at CostGrid" and "Set the limits" steps.
2. The page needs a visual of what the tool does and why it's safe for a business.
3. API keys leak, and a non-technical buyer will hesitate when asked to paste one in.
4. How does CostGrid stop spending? Would it break other tools, like HubSpot, that also use AI?

It also suggested a copywriter or a copywriting tool, and an animated graphic.

## What changed, point by point

### 1. What it does, and why it's different

- **Hero.** The opening paragraph now says what CostGrid does in one sentence. It shows what each AI request costs and who made it, and stops spending at your limit before the request is sent. A second line covers where it runs and how it's priced. The badge now says who it's for: "For businesses building with AI".
- **New "What it is" section,** straight after the hero. The headline is "A meter and a shut-off valve for your AI spend", followed by a two-sentence explanation in everyday words.
- **Three differences,** each on its own card:
  - It stops spend before it happens, rather than reporting it afterwards.
  - Your keys never leave your machine.
  - It's a flat price, never a cut of your bill.
- **Who it's for, stated early.** One card lists who it's built for. The other covers what it doesn't do: AI inside subscribed tools like HubSpot or ChatGPT seats, and software running on a server rather than on the Mac.
- **The three steps, rewritten.** Each one now says exactly what happens and who does it. Step 1 is seeing your past 90 days of spend. Step 2 is sending your software's requests through CostGrid, which it now explains as a CostGrid key and an address in place of the provider's. Step 3 is choosing limits, which start out only measuring.
- **Navigation:** What it is · How it works · Is my key safe? · Pricing · Demo.

### 2. A visual of what it does

An animated diagram at the top of the "What it is" section follows two example requests from a support chatbot.

- **First request, under the limit.** It goes to CostGrid on your machine. CostGrid prices it, charges it to the Support team, and checks Support's monthly limit. It then goes to Anthropic with your key, and the answer comes back.
- **Second request, over the limit.** Later that month Support has used its whole budget. CostGrid stops the next request before it's sent. The chatbot gets an "over budget" reply, nothing is billed, and other teams carry on as normal.
- **A caption under the diagram** explains each of the seven steps in plain words.
- **Two notes under the diagram** say that nothing goes to CostGrid's servers, and that tools like HubSpot are untouched.

It's built to work for every visitor:

- It starts when it scrolls into view and stops when it scrolls away.
- It has a Pause button.
- Visitors who have asked their computer for less motion get a single still frame instead.
- Screen readers get the seven steps as a plain list.
- On a phone it lays out top to bottom.

The numbers in it are labelled as an example. The "about a thousandth of a second" in the caption is the measured 1.2 ms.

### 3. Is my key safe?

A new section with its own navigation link. Four cards:

- **Stored encrypted, on your Mac.** The key is locked with a second key kept in the Mac's keychain. Copying CostGrid's files to another computer doesn't expose it.
- **Sent only to the provider it belongs to.** It goes straight from the Mac to Anthropic or OpenAI over an encrypted connection, never to CostGrid or the website.
- **Never shown again.** The app only ever shows the last four characters, and the activity log doesn't contain even those. The admin key used for the 90-day import is never saved.
- **Kept out of your code.** Your software uses a CostGrid key instead. That key only works on your Mac and can be revoked in the app. The real provider key lives in one place.

Two notes follow. One says what CostGrid does hold: the sign-in email and the three setup answers. The other suggests making a key just for CostGrid, so it can be cut off without affecting anything else.

Every one of these statements was checked against the code before it went on the page.

### 4. How spending is stopped, and whether it breaks other tools

- **New FAQ: "How does CostGrid actually stop the spending?"** Your software sends each request to CostGrid. When a request would go over a limit, CostGrid doesn't pass it on and replies "over budget" instead. Nothing reaches the provider and nothing is billed. A limit can switch to a cheaper model instead of stopping.
- **New FAQ: "Will this break my other tools, like HubSpot?"** No. CostGrid only sees requests your own software sends it, never switches off a key, and doesn't sit in front of other tools. HubSpot's AI runs on HubSpot's account. Only the team that hit its limit is affected.
- **New FAQ: "My AI runs on a server, not a Mac. Can I still use it?"**
- The other FAQ answers were tightened to match. "What doesn't CostGrid do?" was removed because the "Good to know" card now covers it.

### On the copywriting suggestion

I rewrote the copy directly rather than through a separate copywriting tool, so that every sentence could be checked against what the product does. A dedicated copy pass is still worth doing later, ideally once a few real customers have described CostGrid in their own words.

## Things this work turned up

These are now stated honestly on the page, but each is worth a decision.

1. **The Mac app only meters software on the same Mac.** The app accepts connections only from the Mac it runs on. A business whose chatbot runs on a cloud server can't send its requests through the Mac app. The page now says so and offers to set CostGrid up on their server with you. Decide whether you want to offer that by hand.
2. **Switching a limit on is still a command-line step.** In the app, CostGrid can suggest limits and measure them, but enforcing one needs a command. Step 3 now says you'll switch limits on with each customer during the trial. The next thing worth building is a "set a limit" screen in the app.
3. **The 90-day spend import covers Anthropic and OpenAI only,** not Bedrock or Vertex. The page says this.
4. **Some repository files are probably still public on costgrid.dev.** The `.vercelignore` file keeps the code off the website. It doesn't exclude the root `README.md`, `design-system/` or `supabase/`, so those are likely reachable by direct address, though nothing links to them. None of them holds a secret. Now that the code repository is private, they're worth excluding.

## Files

- `index.html`: the home page. Contains all the copy and layout changes above.
- `flow.js`: new. The diagram's animation, kept in its own file so the page doesn't grow further.
- `docs/progress/README.md`: this file. The `docs` folder is not published to the website.

## How it was checked

- **Browser test at desktop and phone widths.**
  - No sideways scrolling and no script errors.
  - The animation steps through all seven stages, and Pause works.
  - Visitors with reduced motion get the still frame.
- **Website sign-in test.**
  - Every sign-in, download and profile check passes.
  - The one failure is the fonts check, and only because the test machine can't reach Google Fonts.
- **Facts checked against the code:** where the key is stored, what the app shows of it, what a stopped request receives, monthly budgets, the revoke button, and which providers the import supports.

## 3 October: closing the gap between the research and the product

An audit of the twelve sources the project was meant to be built on found the product code cited none of them. The workbook used two (Du's price half-lives and EY's $0.04 to $1.20). The homepage said "Grounded in" four, two of which (Stanford HAI, Citadel) traced to nothing. This work closes that gap, in the priority order agreed.

### What was built

1. **Alerts and a stop button.**
   - Alerts go out when a budget is reached, a call is refused, traffic is switched to a cheaper model, or a run costs far more than usual. They arrive as a Mac notification, a Slack or Discord webhook, or both, once per event rather than once per call. The webhook address is stored encrypted.
   - Any agent, team or everything can be stopped with one click from a new Limits screen, from the next call. Resuming keeps the record. The command line equivalent is `costgrid agent stop/resume`.
2. **Reasoning.**
   - Reasoning tokens are now recorded wherever the provider reports them (OpenAI). Claude does not report them separately, so for Claude only what the request asked for is kept.
   - A new rule caps the reasoning effort or thinking budget a request may ask for.
   - The Results screen shows reasoning spend, and flags "short answers after long reasoning".
3. **Measured savings.** When a rule moves traffic to a cheaper model, CostGrid compares cost per call and per run before and after, on the customer's own traffic. It says plainly if the switch made things more expensive, which the price-reversal paper shows happens.
4. **What a run costs.** Each agent's typical (median), bad (95th percentile) and worst run. A warning fires mid-run when a run passes three times what that agent's runs usually cost.
5. **Outcomes, now visible.** Cost per success and money spent on failed runs were already measured but were command-line only. They are now on the Results screen and the monthly statement.
6. **Full cost.**
   - Licences, platform, oversight and the rest of EY's categories can be entered by month.
   - The statement shows metered spend, entered costs and the full cost. It also shows full cost per success, which is Curcio's levelized cost idea.
7. **Rule register and evidence pack.**
   - Every rule shows its owner, reason, when it went live, how often it fired and every change to it, and unowned rules are flagged.
   - A monthly evidence pack (JSON) bundles the statement, the register, measured switches, alerts and the audit log's verification.

### Website

- **New `research.html`:**
  - all twelve sources, each with its finding and the feature it became;
  - each source labelled "Built in", "Shapes" or "Context";
  - a NIST AI RMF crosswalk mapping 12 outcomes to controls and the evidence they produce;
  - a "what we don't claim" section.
- **Homepage:**
  - "Grounded in" is replaced by a link to that page;
  - step 3 now describes the Limits screen;
  - the stop-spending FAQ mentions the stop button and alerts.
- **Fixed:**
  - the research dashboard's price-reversal figures were from the paper's first version;
  - the thesis page linked to the now-private GitHub repository in three places;
  - `.vercelignore` now excludes `README.md`, `design-system/` and `supabase/`.

### Things this work turned up

- **The price table was wrong.** Claude Opus 5.5 was being priced as Opus 5, which overstated every call by 25%. Three new OpenAI models (`gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`) were recorded as unpriced. All 58 models now match the live price pages, checked 3 October 2026.
- **"A mismatch stops a release" was not true.** The FAQ said it, but nothing enforced it. `npm run app:release` now runs the live price check first and stops on any mismatch.
- **None of this reaches testers until a new app version is published.** The website now describes the Limits and Results screens, so release the app (1.0.2) before or together with the website changes.

### How it was checked

- 717 tests pass, up from 684. The new tests cover:
  - stop and resume, with a refused call never reaching the provider;
  - one alert across many refused calls, with webhook delivery;
  - the reasoning cap;
  - reasoning tokens recorded from OpenAI;
  - a measured price reversal;
  - full cost on the statement;
  - the register and the evidence pack;
  - runaway-run warnings.
- The Limits and Results screens were tried in a browser against a gateway seeded with realistic traffic. The research page was checked at desktop and phone widths, with no sideways scrolling.



## Version 2, round 1 (24 October 2026)

**What changed**
- **Cost per successful job.** A new engine in the app's core works out LCSO: what one successful job really costs, with failed and retried attempts charged to the jobs that worked, plus the share of spend on failures and how much the cost of a job varies. It reproduces the method's worked example exactly ($0.390, $1.008 and $1.521 per success; 38.2% on failures). It is not on a screen yet; the results screen (step 5) will use it.
- **A new look.** After three proposals, the "Midnight" direction: dark navy, a champagne accent, and Manrope, a plain readable typeface. The app has a left sidebar, pill buttons and a Dark / Light / Match system setting. Fonts are bundled, so nothing loads from the internet.
- **The website, rebuilt.** New headline, "Optimize your AI costs by what actually gets done.", a preview of the results screen, an illustrative example, Free View and View and control (pricing on request), privacy and key safety, an honest FAQ, and public Mac downloads. Features that aren't built yet are marked "coming". The research page gained the LCSO method (CC BY 4.0). The old thesis and research-dashboard pages were removed and redirect to the research page. Google Fonts is gone and a Content-Security-Policy was added.

**How it was checked**
- 796 tests pass, up from 717 (79 new for the LCSO engine).
- Code review, security review (no findings) and a separate check of every line of website copy against the claims rules; everything they found was fixed or noted.
- The website and the app were looked at in a browser at desktop and phone widths; the app in dark and light.

**Still to do in version 2:** the three-step setup for owners, one key per agent, automatic outcome detection, the results screen, Windows, the key-safety checker, View and control, and the monthly PDF statement.

## Version 2, step 2: three-step setup for owners (24 October 2026)

**What changed**
- **Setup is three steps, with no code.** Sign in (the account stays on this computer), connect Claude, OpenAI or both, then say what each workflow is for. The old proxy steps are still there under "Advanced".
- **Three ways to connect.** A read-only admin key with an expiry date (CostGrid imports 90 days, keeps the key in the Mac's Keychain, checks for new usage every 6 hours, and reminds the owner before it expires); the provider's usage file dropped on the window (no admin access needed); or a ready-written message asking whoever set up the AI to do it. The message never contains a key.
- **Costs per key, workspace or project.** Usage is now broken down by where it came from, and each source can be given a name and a purpose: customer support, sales leads, content, data entry or other, each with what counts as a finished job.
- **Keys never touch the database.** Only the last four characters, the expiry and whether the last check worked are kept there. Deleting the organisation also removes its keys from the Keychain.

**How it was checked**
- 882 tests pass, up from 796. They include the real column layout of both providers' usage files (from the owner's own exports, which had no usage in that month) and checks that a key is in no table, no byte of the database file and no log.
- Code review and a security review (no findings at high confidence). Fixes from the review: a file with no usage no longer wipes days already imported; a new key is not re-imported at the first background check; deleting an organisation removes its admin keys from the Keychain.
- The three steps were tried in a browser on a throwaway database: sample usage files from both providers, two workflows named, at desktop and phone width, in dark and light.

**Still to check with real accounts:** a usage file with real usage in it from each provider, a real Claude admin key in the Mac app (Keychain prompt, key names), OpenAI admin key permissions.

**Website hero (24 October 2026).** The home page opens with a full-screen hero: a floating glass navigation bar, the headline arriving letter by letter, and a glass tagline pill ("See the cost. Spot the waste. Fix it first."). The moving background is CSS (two slow glows and a drifting grid). The reference design used a video hosted by a third party with an unknown licence, so it was left out: loading it would have sent every visitor's IP address to that host. Visitors who ask for less motion get a still page, and without JavaScript everything shows at once.

## Version 2, step 3: one key per agent (24 October 2026)

**What changed**
- **Agents above keys.** Setup's third step is now "Match each key to an agent". An agent is one job the AI does ("Support bot"). The owner names it, picks what counts as a finished job, and chooses which Claude keys, workspaces and OpenAI projects or keys it uses. One agent can use keys from both providers.
- **Shared keys are flagged, not guessed.** Neither Claude nor OpenAI can tell which agent used a shared key, so CostGrid never divides its cost. It marks the key as shared and shows a step-by-step guide to giving each agent its own key (a workspace or project per agent where possible). Spending from before the split stays with the shared key.
- **The same key seen twice is recognised.** A Claude key named in a usage file and the same key seen later through an admin key are matched by name, only when nothing else could be meant. The owner sees "Matched by name" and can undo it with one click.
- **Costs stay honest.** Each agent shows the provider-report cost of its keys (saying how much is a list-price estimate) and, on its own line, any cost CostGrid measured directly. The two are never added together.
- Names and purposes given in step 2 became agents automatically.

**How it was checked**
- 891 tests pass, up from 882 after step 2 (new tests for the upgrade, the agent rules, the name matching and the new routes, including access by other organisations and from other sites).
- In a browser on a throwaway database: sample usage files from both providers, one agent with a Claude key and an OpenAI key, a matched twin and its undo, a shared key and its guide, at desktop and phone width, dark and light.

**Still to check with real accounts:** how a real Claude usage file names keys in the default workspace, before those can be matched too.

## Version 2, step 4: automatic outcome detection (24 October 2026)

**What changed**
- **CostGrid now estimates which jobs got done**, with no logging by the owner. For agents that send requests through CostGrid, each job is judged from how the agent behaved: handed to a person, ended in an error, cut off, declined, or asked again soon after. A job that ended normally and wasn't asked again counts as finished once its waiting period passes. All of this is labelled "indicative"; a one-line report from the owner's software always wins and is shown separately.
- **Recognising the same job.** A developer can label each job (`x-costgrid-task`). Without a label, CostGrid turns the job's first message into a one-way code on the computer. The words are never saved, the code can't be turned back into them, it never leaves the computer, and it is deleted with the call records. On by default, with an off switch in Settings that also deletes saved codes.
- **Presets version 2** add how soon a repeat means the first try failed (24 hours for support, 48 for sales leads, 2 for data entry) and rate their evidence for automatic detection. Agents set up earlier keep version 1 until the owner turns detection on with one click.
- **Results screen:** a new "Did the jobs get done?" section per agent: finished, didn't finish, stopped by your limits, still waiting, can't tell, the reasons, and an indicative cost per finished job.
- **Website:** the privacy card now says CostGrid never *keeps* prompts or answers and explains the one-way code; step 2 of "How it works" describes the estimates.

**How it was checked**
- 923 tests pass (rules for every signal and window edge, the code never containing the message, the switch deleting codes, the read model, and the new routes including access from other organisations and sites).
- Security review: nothing at high confidence; one hardening suggestion taken (each organisation gets its own fingerprint key).
- In a browser against a fake provider: a finished job, a job asked twice, a hand-off, a cut-off answer, a too-short opening and a labelled job all landed where they should; Results and the Settings switch at desktop and phone width, dark and light.

**Not yet:** agents known only from provider usage reports have no outcomes until a helpdesk connection exists (later in the plan).

## Version 2, step 5: the plain-language results screen (25 October 2026)

**What changed**
- **One sentence per agent.** Each agent on Results now opens with a verdict, picked by fixed rules from the cost-per-job figures: money spent and no job finished (flagged in amber), too early to say, a finished job costs more than a person would, most of the money goes on jobs that don't finish, a bad job costs 3× or more a typical one, or steady. Beside it: cost per finished job, share of spending on jobs that didn't finish, and a typical job against a bad one. Everything is labelled indicative.
- **Compared with a person.** An owner can enter how many minutes a person takes per job and what their hour costs. The card then says what share of that the AI's model cost is, as the owner's estimate.
- **Agents seen only in provider reports.** An owner can enter last month's count of finished jobs (and optionally those that didn't finish). The card then shows a cost per finished job for that month, from the provider's usage report and that count, and says why failure share and cost spread can't be shown.
- **Website:** "How it works" step 3 describes the verdicts instead of calling them "coming".

**How it was checked**
- 943 tests pass. New: every verdict rule at its boundary; the owner's estimates stored, refused when nonsense, and removed with their agent; the totals-only price for a counted month; and the new routes (owner only, other organisations, future months refused).
- Found and fixed along the way: one database test file had silently stopped running since step 3 (a leftover fragment broke it); it runs again.
- Code review: fixed a misleading verdict when a month's report hadn't been imported yet, future months being accepted, estimates outliving a removed agent, repeated form ids, and a slow lookup.
- In a browser with five sample agents: each verdict kind, saving a person estimate and a job count, dark and light, desktop and phone width with no sideways scrolling.

## Version 2, step 6: key-safety warnings (25 October 2026)

**What changed**
- **Setup now ends with "Key safety".** Each warning says what could go wrong and the one thing that fixes it at the provider. Fix now: an admin key that has expired or whose sync is failing. Worth fixing: an admin key expiring within 14 days, a key shared by several agents, spending on a key no agent is matched to, a key that still works but hasn't been used for 90 days. Good practice: a Claude key in the Default workspace (no spending limit of its own), an OpenAI key owned by a person rather than a service account, a key over a year old.
- **Nothing new is fetched.** The key lists CostGrid already reads for key names also say each key's status, age, last use (OpenAI only), owner type and workspace; that metadata is now kept. A list that couldn't be read in full keeps nothing, so no key is dropped from the checks by mistake, and forgetting the admin key clears it.
- **Honest about what can't be seen.** Claude doesn't report when a key was last used, so an idle Claude key is described as "no use seen in the last 90 days", not "never used".
- **Website:** "Warnings about risky key setups" is no longer marked "coming".

**How it was checked**
- 951 tests pass. New: every warning at its threshold, the order they come in, reading key facts from both providers' lists (including archived OpenAI projects and a list cut off after 50 pages), and the route (other organisations, no key in the response, cleared on disconnect).
- Code review: fixed keys in archived OpenAI projects counted as working, a wrong "never used" for Claude keys, facts outliving a forgotten admin key, a metadata write that could fail a whole import, and partial lists replacing full ones.
- In a browser: Setup with an expiring admin key, a shared key, an old idle key in the Default workspace and a person's key, desktop and phone width.

**Still to check with real accounts:** the exact fields a real Claude and OpenAI key list returns (status values, `workspace_id` for the Default workspace, `owner.type`).

## Version 2, steps 7 and 8: View and control (25 October 2026)

**What changed**
- **Two tiers.** View (free) and View and control, kept apart from the older price plans and with no price attached. Until pricing is decided, whoever runs the install turns it on with `costgrid tier control`.
- **Pause an agent's Claude keys** from Limits, with one click and a confirmation. CostGrid checks each key first and only turns off keys that were working; a workspace means every working key in it. **Resume** turns back on exactly what CostGrid turned off, and stays available after a move back to View or after the agent is removed, so no key is left off by accident. Anthropic's Admin API is used (`inactive` and `active`, never `archived`), and a pause counts only when Anthropic reports the new status.
- **OpenAI keys can't be paused**: OpenAI documents no way to do it. They are listed as such, with what to do in the OpenAI dashboard instead.
- **Monthly caps per agent.** Organisations with a cap are synced hourly. When the provider's usage report shows an agent past its cap this month, its Claude keys are paused and one alert says what was reached and what was done. A cap pauses once per month per setting: if the owner resumes, CostGrid doesn't overrule them until the cap is changed. A failed pause is retried.
- **Measured stop time.** Every pause and resume is listed with how far behind the usage report was when the cap was seen and how long Anthropic took to act. Nothing says "instant".
- **Website:** the pricing card describes what View and control does now, says OpenAI keys can't be paused, and says a cap acts on a report that runs behind.

**How it was checked**
- 957 tests pass, against a fake Anthropic Admin API that keeps each key's status: only working keys paused, only CostGrid's pauses resumed, the admin key only ever in the request header, caps once a month, a failed pause retried, resume after the tier or the agent is gone, owner only, other organisations and other sites refused, no audit entries when there is nothing to pause.
- Code review: fixed a failed cap pause stopping the cap for the month, keys stranded off after a tier change or a removed agent, an alert that said keys were being paused when they weren't, two cap checks racing, a full sync swallowed by a partial one, and pausing an agent that doesn't exist.
- In a browser: pause, set a cap, resume, with the confirmation, at desktop and phone width.

**Needs your decision:** the in-app wording of "What CostGrid sends, and to whom" (Limits), which is privacy wording; how View and control is granted once pricing is set; and whether the website's privacy card ("a plain list... is coming") can now point to it.

**Still to check with real accounts:** pausing and resuming a real Claude key (and how long Anthropic takes), the `status` filter on the key list, and whether a real admin key is allowed to change key status.

## Version 2, step 9: cost per finished job on the statement (25 October 2026)

**What changed**
- **The monthly statement says whether the jobs got done.** Text, CSV, JSON and the printable HTML statement, and the evidence pack, now have a "Did the jobs get done?" section per agent: finished, not finished, still waiting, cost per finished job, the share spent on jobs that didn't finish, comparison with your person estimate, and a one-line verdict. Every figure is marked indicative and says where the counts came from: inferred from behaviour, reported by your software, or your own count.
- **A closed month is judged as of the day the statement is made**, reading runs after the month ended, so a job finished on the 30th has had its waiting period and one asked again in the next month counts as not finished.
- Agents whose purpose predates automatic detection are listed as not judged rather than left out.
- The statement API includes the section only with `?include=jobs`, so a dashboard polling the statement doesn't make the metering process judge every job.

**How it was checked**
- 958 tests pass, including a month-end job judged after the month closed and the CSV row with its agent id.
- Code review: fixed month-end jobs stuck as "waiting" on closed months, owner counts for an older month vanishing once a newer one was entered, unjudged agents left out silently, the CLI's JSON mangling exact figures, and a failure in this section being able to break the whole statement.
- Rendered the text and HTML statements with sample agents.

## Brand accent: champagne to lavender (25 October 2026)

The one accent colour is now lavender (`#c2a9ff` in dark mode, `#6a4bd6` in light), replacing champagne gold, so it sits with the website's violet and blue glows. Changed in the design system's tokens and synced to the app and the demo; the website, the logo and favicon on every page, the hero glow and the hero video's tint follow. Contrast: lavender text on the dark background is 9.6:1, dark text on a lavender button 9.0:1, and the light-mode accent 5.9:1 on white. Green, amber and red still mean state only. The app picks this up in its next release; the Mac app icon (red, white and green bars) is unchanged and is due a redesign of its own.
