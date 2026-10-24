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
