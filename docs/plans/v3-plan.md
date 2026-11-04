CostGrid v3 plan

Choosing the best model for every task, on cost and quality

Draft for decision · 25 October 2026

In one page

**The goal.** v3 makes CostGrid answer, for every task an agent sends: **which model will do this job well enough, for the least money?** It then sends the task there, checks the result, learns from it, and explains every choice.

**The rule.** CostGrid does not claim to lower costs until it has done so on real customer traffic, measured by the standard in D2.

**What is needed now.** 18 decisions, listed in section 5 with a recommendation for each. Only D3 (which businesses' traffic proves it) cannot be defaulted.

1\. What CostGrid does today (v2)

- **Measures** what AI costs per finished job, from the providers' bills or from traffic sent through CostGrid, including the money spent on jobs that didn't finish and, once entered, the cost of people and tools.

- **Judges** each agent in plain words (steady, unpredictable, mostly failures, dearer than a person) and warns about risky API keys.

- **Governs** with spending limits, tool allow and deny lists, a rule register with owners, an audit log and a monthly evidence pack mapped to the NIST AI RMF.

- **Controls** by pausing an agent's Claude keys at Anthropic, by hand or when a monthly cap is reached.

How it changes models today

For requests sent through CostGrid, it moves a call to another model in only two cases:

- **A routing rule**: “for this agent, send model A's calls to model B.” It applies to every matching call regardless of what the call asks, within the same provider only, and can run as a dry run first.

- **A budget fallback**: an agent over budget is moved to a cheaper model instead of being refused. Same provider only.

Rules are written by hand, or suggested from one weak clue (an expensive model giving short answers), always pointing at the cheapest model of the same provider. Autopilot can create them, but it is off by default and runs only when started. After a switch, CostGrid compares cost before and after, but it does not check quality and does not switch back on its own.

What it does not do

- Choose a model per request based on what the request asks.

- Use open models, or move work between providers.

- Judge a switch by the quality of the work, or by whether jobs still finish.

- Test a candidate model on a small share of jobs, or undo its own mistakes.

2\. What “best model” means in v3

For each task, the router weighs three things for every candidate model:

- **Quality**: how good its finished work is on this kind of task.

- **Cost**: what a finished job costs, counting failures, retries, reasoning and extra steps.

- **Reliability**: how often it finishes at all.

The owner picks per agent how to trade them off: **same quality, lower cost** (the default); **best quality within a budget per job**; or **best value**, where the owner says roughly what a better answer is worth.

A job only counts as a success if it finished **and** met the quality bar. The headline figure becomes **cost per good job**, which fits the cost measure CostGrid already uses.

This follows the research the product was built on: a cheaper price per token can cost more overall (arXiv:2603.23971), more reasoning does not always help (arXiv:2506.06941), cost can be estimated before a task runs (arXiv:2604.22750), and full cost per outcome is what matters (LCOAI, arXiv:2509.02596).

3\. How the router works

1.  **Understand the task**: what kind of work it is, how long, whether it uses tools, which agent sent it, and whether this job has been seen before.

2.  **Predict, for each candidate model**: the quality of its answer, the chance it finishes, and its cost including reasoning.

3.  **Choose** the model that best fits the agent's mode. When unsure, choose the safer model.

4.  **Optionally try cheap first**: if the answer clearly fails, resend to a stronger model.

5.  **Learn**: each job's result updates the predictions. A small share of traffic keeps testing other models where the router is unsure, so it notices when a cheaper or new model becomes good enough.

Measuring quality

From cheapest and most common to most reliable:

- **Signals from real use**: accepted or rejected, edited heavily, asked again, handed to a person, tests passed, ticket closed without reopening.

- **Checks on the answer**: correct format, required fields, not cut off, no refusal.

- **A quality score** from the customer's software, such as a user's thumbs up or a reviewer's mark.

- **Side-by-side comparison** on a small sample: the same task to two models, a grader picks the better answer.

- **Owner spot checks** of a few sampled answers each week.

4\. The introspective part

- **Every choice has a reason**: predicted quality, cost and chance of finishing, how sure it is, and the models it rejected. For example: “Sent to model X: same quality as model Y on 96% of 140 compared tasks, 61% lower cost per good job.”

- **It checks its own predictions** weekly against what happened, trusts itself less where it was wrong, and tells the owner.

- **It checks its grader** against the owner's spot checks and reports how often they agree. Automated graders favour longer answers and their own model family.

- **It knows what it doesn't know**: new task types, new models and thin data are flagged, and it plays safe.

- **It undoes its own mistakes**: if quality, jobs finished or cost per good job worsen after a change, it switches back and says why.

- **You can ask it**: “Which model is best for this agent, or for this sample task?” gets a ranked list with quality, cost, reliability, confidence and evidence.

5\. Decisions

Each decision has a recommendation. Reply “go with the recommendations” to accept them all, or change any by its number.

Proof and claims

<table>
<colgroup>
<col style="width: 6%" />
<col style="width: 23%" />
<col style="width: 37%" />
<col style="width: 32%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>#</strong></th>
<th><strong>Decision</strong></th>
<th><strong>Options</strong></th>
<th><strong>Recommendation</strong></th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td><strong>D1</strong></td>
<td>What does the website say until savings are proven?</td>
<td><p>A: Keep “Optimize your AI costs.”</p>
<p>B: “Find out what each finished job costs, and test cheaper ways to do it.” Savings claims added once measured.</p></td>
<td><strong>B.</strong> One line now protects trust later.</td>
</tr>
<tr class="even">
<td><strong>D2</strong></td>
<td>What counts as a real saving?</td>
<td>A number agreed before building, so the result can't be argued with afterwards.</td>
<td><strong>At least 20% lower cost per good job, with quality and jobs finished no worse, on at least 200 jobs per agent of real customer traffic.</strong></td>
</tr>
<tr class="odd">
<td><strong>D3</strong></td>
<td>Whose traffic proves it?</td>
<td>Routing only works on requests sent through CostGrid, and the router learns quality from that traffic.</td>
<td><strong>Your decision.</strong> Name 1–3 businesses willing to send one agent's traffic through CostGrid. Nothing is claimed until their results meet D2.</td>
</tr>
<tr class="even">
<td><strong>D4</strong></td>
<td>How do we charge for routing?</td>
<td><p>A: Included in View and control.</p>
<p>B: A separate tier.</p>
<p>C: A share of measured savings.</p></td>
<td><strong>A for the first customers.</strong> Decide on C once D2 has real results behind it.</td>
</tr>
</tbody>
</table>

Which models it can use

<table>
<colgroup>
<col style="width: 6%" />
<col style="width: 23%" />
<col style="width: 37%" />
<col style="width: 32%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>#</strong></th>
<th><strong>Decision</strong></th>
<th><strong>Options</strong></th>
<th><strong>Recommendation</strong></th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td><strong>D5</strong></td>
<td>Which models can the router send work to?</td>
<td><p>A: Same provider only (today).</p>
<p>B: Across Claude and OpenAI.</p>
<p>C: Also open models, through any service that accepts OpenAI-format requests (self-run or hosted).</p></td>
<td><strong>C.</strong> Open models first, then Claude and OpenAI in both directions. Bedrock and Vertex models later.</td>
</tr>
<tr class="even">
<td><strong>D6</strong></td>
<td>Open models and the privacy promise.</td>
<td><p>The site says keys are “only ever sent to OpenAI or Anthropic.”</p>
<p>A: Only models the customer runs themselves.</p>
<p>B: Also hosted services the customer picks and connects with their own key.</p></td>
<td><strong>B, opt-in per agent</strong>, with the privacy wording changed in the same release.</td>
</tr>
</tbody>
</table>

Understanding the task

<table>
<colgroup>
<col style="width: 6%" />
<col style="width: 23%" />
<col style="width: 37%" />
<col style="width: 32%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>#</strong></th>
<th><strong>Decision</strong></th>
<th><strong>Options</strong></th>
<th><strong>Recommendation</strong></th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td><strong>D7</strong></td>
<td>How does the router understand a task?</td>
<td><p>A: Simple signals only (length, tools, agent, repeated job).</p>
<p>B: A small model inside CostGrid, on the customer's computer, reads the request in memory and labels the kind of task. Words never stored or sent.</p>
<p>C: An outside AI service labels each task.</p></td>
<td><strong>B, with A as the fallback.</strong> The current privacy promise holds.</td>
</tr>
<tr class="even">
<td><strong>D8</strong></td>
<td>Where does it start before it has data?</td>
<td><p>A: Play safe: keep the current model, test slowly.</p>
<p>B: Start from public benchmark results, adjusted as the customer's own data arrives.</p></td>
<td><strong>B for the first guess</strong>, but no real traffic moves until the customer's own data supports it.</td>
</tr>
</tbody>
</table>

Quality

<table>
<colgroup>
<col style="width: 6%" />
<col style="width: 23%" />
<col style="width: 37%" />
<col style="width: 32%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>#</strong></th>
<th><strong>Decision</strong></th>
<th><strong>Options</strong></th>
<th><strong>Recommendation</strong></th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td><strong>D9</strong></td>
<td>What does “best” mean by default?</td>
<td><p>1: Same quality, lower cost.</p>
<p>2: Best quality within a budget per job.</p>
<p>3: Best value: the owner says roughly what a better answer is worth.</p></td>
<td><strong>1 as the default</strong>, with 2 and 3 available per agent.</td>
</tr>
<tr class="even">
<td><strong>D10</strong></td>
<td>Which quality sources does it use?</td>
<td><p>1: Signals from real use (accepted, edited, asked again, handed to a person, tests passed).</p>
<p>2: Checks on the answer (format, fields, not cut off, no refusal).</p>
<p>3: A quality score sent by the customer's software.</p>
<p>4: Side-by-side comparison by a grader on a sample.</p>
<p>5: Owner spot checks.</p></td>
<td><strong>1–3 always on; 4 on a 1–2% sample the owner turns on; 5 offered weekly.</strong></td>
</tr>
<tr class="odd">
<td><strong>D11</strong></td>
<td>Who grades side-by-side comparisons?</td>
<td><p>A: A stronger model from a provider the customer already uses.</p>
<p>B: A small local model.</p>
<p>C: People only.</p></td>
<td><strong>A, opt-in</strong>, its cost counted in the agent's costs, <strong>with C (spot checks) keeping the grader honest.</strong></td>
</tr>
<tr class="even">
<td><strong>D12</strong></td>
<td>Add a quality score to outcome reporting?</td>
<td>Today the customer's software can report whether a job finished.</td>
<td><strong>Yes: an optional 0–1 score per job.</strong> Small change, most useful signal.</td>
</tr>
<tr class="odd">
<td><strong>D13</strong></td>
<td>Who sets the quality bar?</td>
<td><p>A: The owner, per agent.</p>
<p>B: A default of “never worse than the current model.”</p></td>
<td><strong>B by default</strong>, owner can loosen it per agent.</td>
</tr>
</tbody>
</table>

Control

<table>
<colgroup>
<col style="width: 6%" />
<col style="width: 23%" />
<col style="width: 37%" />
<col style="width: 32%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>#</strong></th>
<th><strong>Decision</strong></th>
<th><strong>Options</strong></th>
<th><strong>Recommendation</strong></th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td><strong>D14</strong></td>
<td>Who switches models, and what if it gets worse?</td>
<td><p>A: CostGrid suggests, the owner approves.</p>
<p>B: CostGrid switches within limits the owner sets.</p></td>
<td><strong>A until an agent passes a trial, then B for that agent.</strong> Switches back by itself whenever results get worse. Automatic switching only on agents with quality signals beyond inference (D10 sources 1–3).</td>
</tr>
<tr class="even">
<td><strong>D15</strong></td>
<td>Allow “cheap first, then step up”?</td>
<td>Send to the cheap model; resend to a stronger one if the answer clearly fails. Adds delay on resent jobs.</td>
<td><strong>Yes, per agent</strong>, off where speed matters.</td>
</tr>
<tr class="odd">
<td><strong>D16</strong></td>
<td>How much traffic goes on testing?</td>
<td>Testing keeps checking other models where the router is unsure.</td>
<td><strong>About 5% to start</strong>, lower once confident, <strong>never</strong> on work the owner marks critical.</td>
</tr>
<tr class="even">
<td><strong>D17</strong></td>
<td>One model per agent, or per request?</td>
<td>Per agent is simpler and reliable. Per request is the end goal in the research.</td>
<td><strong>Per agent first, then per request</strong> once trials have produced data.</td>
</tr>
</tbody>
</table>

Quick wins alongside

| **\#**  | **Decision**                                          | **Options**                                                                                                                                             | **Recommendation**                                                                                   |
|---------|-------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| **D18** | Build guaranteed savings that don't change the model? | Provider batch services (half price for work that can wait), better use of prompt caching, lowering reasoning effort on agents flagged as overthinking. | **Yes, first.** A few days each, measurable at once, and the first proof that CostGrid lowers bills. |

6\. Build order

Each phase ships on its own, is tested, and is committed before the next starts.

| **Phase**                        | **What ships**                                                                                                                                                                    | **Needs**         | **Done when**                                                                 |
|----------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------|-------------------------------------------------------------------------------|
| 0\. Decide                       | D1–D18 answered. Website wording changed (D1). First customers named (D3).                                                                                                        | All decisions     | This document signed off; customers agreed to send one agent's traffic.       |
| 1\. Quick wins                   | Batch service routing, prompt caching checks, reasoning effort lowering, each with a measured before-and-after report.                                                            | D18               | A measured saving on real traffic, without changing models.                   |
| 2\. Quality foundations          | Quality score in outcome reporting; answer checks; real-use signals; “cost per good job” in the cost measure and statement; a decision log recording every choice and its reason. | D9, D10, D12, D13 | Every agent shows cost per good job and a quality spread.                     |
| 3\. Reach                        | Prices for open models; a connection to any OpenAI-format service; request translation between Claude and OpenAI formats; privacy wording updated.                                | D5, D6            | A Claude-format request can be served by an open model and priced exactly.    |
| 4\. Understanding and prediction | Local task labelling; for each candidate model, predicted quality, cost (including reasoning) and chance of finishing, starting from benchmarks.                                  | D7, D8            | For any request, a ranked list of models with predictions and how sure it is. |
| 5\. Trials and per-agent routing | Testing share per agent; side-by-side grading and owner spot checks; switching per agent with owner approval, then automatically; switching back when worse.                      | D11, D14, D16     | An agent moved to a better-value model on evidence, with quality no worse.    |
| 6\. Per-request routing          | A model chosen for each request; cheap first, then step up; self-checks of predictions and grader agreement; “Which model is best for this task?” in the console.                 | D15, D17          | Predictions match results within the bounds the router reports.               |
| 7\. Prove and launch             | Results from the first customers measured against D2; savings claims on the website; pricing decided; v3 released.                                                                | D2, D4            | D2 met on real traffic, then published.                                       |

7\. What already exists to build on

| **Already in CostGrid**                                             | **Used in v3 for**                                 |
|---------------------------------------------------------------------|----------------------------------------------------|
| Recognising a repeated job (one-way code of the first message)      | Task history and “asked again” as a quality signal |
| Whether each job finished, inferred or reported                     | Reliability, and the base of cost per good job     |
| Cost per finished job (LCSO method)                                 | Extended to cost per good job                      |
| Reasoning cost tracked separately, reasoning caps                   | Choosing reasoning effort per task                 |
| Routing rules, dry runs, budget fallback, autopilot limits and undo | The switching mechanism, now driven by evidence    |
| Before-and-after check on each switch                               | Extended with quality and automatic switch-back    |
| Bedrock and Vertex connections for Claude                           | More places to serve a chosen model                |
| Rule register and audit log                                         | Recording each routing choice and its reason       |

8\. Risks

| **Risk**                                                    | **How the plan handles it**                                                                                                |
|-------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| Quality is measured wrongly, so a worse model looks as good | Several sources, grader checked against owner spot checks, automatic switching only where quality signals exist (D10, D14) |
| Prompts reach a new party                                   | Task labelling runs locally (D7); open models opt-in per agent; privacy wording changed in the same release (D6)           |
| Too little data to learn from                               | Benchmark starting point (D8), safe default when unsure, real customers named first (D3)                                   |
| Testing harms real work                                     | 5% share, never on critical work, switch back on any worsening (D16, D14)                                                  |
| Grading costs eat the saving                                | Small sample, opt-in, grading cost counted in the agent's cost (D10, D11)                                                  |
| Slower answers from cheap-first                             | Per agent, off where speed matters (D15)                                                                                   |
| Claiming savings too early                                  | No claim until D2 is met on real traffic (D1, phase 7)                                                                     |
