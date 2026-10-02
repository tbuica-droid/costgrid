# CostGrid: where we are, and what changed after the first outside feedback

Updated 2 October 2026.

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
