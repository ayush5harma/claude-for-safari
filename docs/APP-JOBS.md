# App jobs (`/app/*`)

The hub can run four kinds of job for a native companion app (for example a
personal-finance app on a phone): it turns masked credit card statement text
into structured rows, it turns a card's published terms and conditions into a
reward rule set, it refreshes a shopping shortlist with current Indian
prices and sales, and it answers a question about one section of the app and
proposes changes to its data. The app submits a job, polls it, and deletes it
after reading. The logic lives in `bridge/app-jobs.js`; the bridge
loads it only when `BRIDGE_APP_TOKEN` is set.

Jobs are asynchronous because Heroku's router drops a request that stays
silent for 30 seconds, and a real statement, or a terms job with several cards,
takes longer than that.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_APP_TOKEN` | unset | Turns `/app/*` on. Without it every `/app/*` route answers 404. At least 16 characters and different from `BRIDGE_TOKEN`, or the hub refuses to start. |
| `BRIDGE_APP_FETCH_DOMAINS` | empty | Hosts a terms job may fetch from, comma- or space-separated, matched exactly against the URL's host (`www.bank.example` does not admit `bank.example`, and a non-default port is part of the host). Empty means terms jobs are refused. |
| `BRIDGE_APP_SHOP_DOMAINS` | empty | Retail hosts a shopping job may fetch from, comma- or space-separated. An entry admits that host and its `www.` form (`amazon.in` admits `amazon.in` and `www.amazon.in`) and nothing else: not other subdomains, not a longer name that ends the same way, not another port. Empty means shopping jobs still run but fetch nothing: Claude answers from its own knowledge and every price is marked unverified. Example: `amazon.in,flipkart.com,croma.com,reliancedigital.in,vijaysales.com,ikea.com,pepperfry.com,urbanladder.com,wakefit.co,godrejinterio.com,durian.in,homecentre.in,featherlitefurniture.com,flexispot.in`. |
| `BRIDGE_APP_TIME_ZONE` | `Asia/Kolkata` | The IANA time zone a job's "today" is computed in: a terms card's and a shopping result's `checkedOn`, and the date their prompts give Claude (for `verifiedOn`). The host's own zone is not used, because a Heroku dyno runs in UTC. An unknown zone stops the hub from starting. |
| `BRIDGE_APP_SAFARI_FALLBACK` | unset (off) | `1` lets a terms job read a source through a background tab of the owner's Safari when the hub's own fetch fails in a way a browser can get past. This gives the app token a bounded reach into the browser; see [Safari fallback](#safari-fallback-off-by-default). Any other value leaves it off. |

Mint the token the same way as `BRIDGE_TOKEN` (`openssl rand -hex 24`). On
Heroku, set both as config vars ([HOSTING.md](../HOSTING.md)); the deploy
script ships `app-jobs.js` beside the bridge. `install.sh` does not copy any
of these variables into the launchd plist, so a local hub that should serve
the app needs them in its own environment.

## Authentication

- `/app/*` accepts only `Authorization: Bearer <BRIDGE_APP_TOKEN>`.
  `BRIDGE_TOKEN` gets 401 there.
- `BRIDGE_APP_TOKEN` gets 401 on every other route, including on a loopback
  hub that has no `BRIDGE_TOKEN`. A leaked app token cannot reach the browser
  tools, the chat panel or the MCP routes. With the Safari fallback off (the
  default) it cannot make the browser do anything. With it on, it can make
  Safari load and read a bounded set of pages; the
  [Safari fallback](#safari-fallback-off-by-default) section lists exactly what.
- A request that carries `Origin` or `Sec-Fetch-Site` gets 403. Browsers send
  one of the two on every request and a native client sends neither, so a web
  page that learns the token still cannot use it.
- Responses carry `Cache-Control: no-store`.
- The hub removes `BRIDGE_APP_TOKEN` from the environment it passes to panel
  turns, and a job's child gets no `BRIDGE_*` variable at all.

## Routes

`GET /app/health` is the app's "test connection". It returns
`{ ok, error, cli, types, defaultModel, fetchDomains, shopDomains, safariFallback, timeZone, running, queued, limits }`.
`cli` is `{ state, version, missing }`: what the startup probe of the Claude
CLI found (see [How a job runs](#how-a-job-runs)). `state` is `checking`, `ok`
or `unusable`; when it is `unusable`, `ok` is false and `error` says why.
`safariFallback` is true when `BRIDGE_APP_SAFARI_FALLBACK=1`.
`types` lists the job types this hub runs (`statement-extract`, `terms-extract`,
`shopping-refresh`, `assistant`), so the app can tell whether the hub it is
talking to is new enough for a feature before it submits one.

`POST /app/jobs` returns `202 {"jobId": "<uuid>", "status": "queued"|"running"}`.
Validation failures return 400 with an `error` string. An oversized body or
text returns 413, a full queue returns 429, and a hub whose Claude CLI failed
the startup probe returns 503 with the probe's error.

A statement job:

```json
{ "type": "statement-extract",
  "input": { "text": "<masked statement text, at most 200000 characters>",
             "hint": { "issuer": "Example Bank", "product": "Example Card", "last4": "0000" },
             "model": "sonnet" } }
```

`hint` and `model` are optional; `last4` must be four digits.

A terms job (1 to 10 cards, 1 to 5 https sources each, every host on the
allowlist, `cardKey` matching `^[a-z0-9][a-z0-9-]{0,39}$` and unique):

```json
{ "type": "terms-extract",
  "input": { "cards": [ { "cardKey": "example-card", "issuer": "Example Bank",
                          "product": "Example Card",
                          "sources": ["https://www.bank.example/card-terms.pdf"],
                          "current": null } ],
             "model": "sonnet" } }
```

`current` is the card's present rule set or null. Claude keeps the ids of
rules that have not changed.

A shopping job (`type` is `shopping-refresh`; every field but `prompt` and
`model` is required, and a field not listed here is a 400):

```json
{ "type": "shopping-refresh",
  "input": { "city": "Example City", "month": "November 2026", "currency": "INR",
             "categories": [ { "category": "Refrigerator",
                               "constraints": "double door, 250 to 300 litres, inverter, 3 star or better" },
                             { "category": "Study desk", "constraints": "at least 120 cm wide, with drawers" } ],
             "prompt": "Prefer well-known brands with local service.",
             "model": "sonnet" } }
```

`city` (100 characters), `month` (40), each `category` (100) and each
`constraints` (500, may be empty or left out) are one-line strings; `currency`
must be `"INR"`; there are 1 to 12 categories. `prompt` is optional extra
instructions from the app, at most 4,096 characters (413 beyond), and may span
lines. It can steer which products Claude picks, but it cannot change the
output rules or make a price verified.

An assistant job (`type` is `assistant`; every field but `context` and `model`
is required, and a field not listed here is a 400):

```json
{ "type": "assistant",
  "input": { "section": "finance",
             "question": "Remind me on the 10th to pay the card bill.",
             "today": "2026-11-26",
             "context": "Plain-text digest of the section's data, identifiers masked.",
             "actions": ["createReminder", "addTodo"],
             "model": "sonnet" } }
```

`section` is one of `summary`, `home`, `finance`, `health`, `moveIn`.
`question` is 1 to 2,000 characters (413 beyond) and `today` a real
`YYYY-MM-DD` date, the owner's day. `context` is 0 to 12,000 characters (413
beyond) and may be left out: it is a plain-text digest the app builds, and
the only thing Claude may answer from. `actions` is a non-empty list of the
kinds the app is willing to apply, from `createReminder`,
`rescheduleReminder`, `completeReminder`, `appendReminderNote`, `createEvent`,
`moveEvent`, `addTodo`, `rescheduleTodo`, `completeTodo`, `addMoveInItem` and
`markInterestPaid`; a kind that is not in this list is a 400 naming its
position (`input.actions[1] is not an action kind: use ...`), a repeat is
ignored.

`GET /app/jobs/<jobId>` returns:

```json
{ "jobId": "…", "type": "statement-extract", "status": "queued|running|done|failed",
  "progress": { "done": 0, "total": 1 }, "result": null, "error": null,
  "createdAt": "<ISO 8601>", "finishedAt": null }
```

`result` is set only when `status` is `done`, and `error` only when it is
`failed`. For a terms job, `progress.total` is the number of cards. For a
shopping job it is 3: pages chosen, pages fetched, answer written. For an
assistant job it is 1, as for a statement.

`DELETE /app/jobs/<jobId>` purges the job at once and kills its child if it
is running. A finished job is purged 15 minutes after it ends either way, so
read the result promptly.

## Results

A statement job's `result` is a StatementExtraction (`schemaVersion` 1).
A terms job's `result` is a TermsResult:
`{ "cards": [ { cardKey, status, checkedOn, sources, ruleSet, notes } ] }`.
Both shapes are defined once in `app-jobs.js` (`STATEMENT_SHAPE`,
`RULE_SET_SHAPE`, `TERMS_CARD_SHAPE`), and the same definitions generate the
CLI's `--json-schema` and drive the bridge's own checker.

A shopping job's `result` is a ShoppingResult:

```json
{ "checkedOn": "2026-11-23",
  "categories": [ { "category": "Refrigerator",
                    "options": [ { "name": "Example Brand 260 L double door", "priceINR": 27990,
                                   "seller": "Example Retailer", "url": "https://www.example-retailer.in/s?k=refrigerator",
                                   "saleNote": "10% bank offer listed", "verified": true },
                                 { "name": "Example Brand 280 L double door", "priceINR": null,
                                   "seller": null, "url": null, "saleNote": null, "verified": false } ],
                    "recommendation": "Buy the 260 L: it is the cheapest verified option that fits." } ],
  "notes": "One page could not be read." }
```

One entry per requested category, in the order asked, spelled as asked. Every
key is present. An unknown price is `null`, never 0 (a 0 fails the schema
check and the job retries). `priceINR` is one number, not a range. The shape
is `SHOPPING_RESULT_SHAPE` in `app-jobs.js`.

`verified` is `true` only when the bridge can vouch for it: the option has a
price and its `url` is a page the hub itself fetched for this job. Claude is
told the same, but the bridge enforces it: an option Claude calls verified
without a price or without a fetched page behind it is changed to `false`,
and `notes` says how many. With no shopping allowlist, or when no page could
be read, nothing is verified. A `url` that is not https on the shopping
allowlist becomes `null`, so a fetched page cannot put its own link in front of
the owner. `checkedOn` is the hub's date in `BRIDGE_APP_TIME_ZONE`, whatever
Claude wrote. `notes` carries Claude's own remarks first and then the bridge's
(pages not fetched or not readable, links removed, options downgraded).

An assistant job's `result` is an AssistantResult:

```json
{ "answer": "The card bill is due on the 12th; the context shows no other payment this month.",
  "actions": [ { "kind": "createReminder", "why": "You asked to be reminded to pay the card bill.",
                 "title": "Pay the card bill", "due": "2026-12-10T09:00" } ],
  "dropped": 0 }
```

`answer` is plain text, 1 to 2,000 characters. `actions` holds 0 to 8 objects,
each `{ kind, why }` (`why` is one line, at most 200 characters) plus the fields
its kind takes; an optional field that is not set is left out, not `null`:

| Kind | Fields |
| --- | --- |
| `createReminder` | `title`, `due?`, `notes?` |
| `rescheduleReminder` | `reminderID`, `due` |
| `completeReminder` | `reminderID` |
| `appendReminderNote` | `reminderID`, `notes` |
| `createEvent` | `title`, `start`, `end`, `notes?` |
| `moveEvent` | `eventID`, `start`, `end` |
| `addTodo` | `title`, `due?`, `notes?` |
| `rescheduleTodo` | `todoID`, `due` |
| `completeTodo` | `todoID` |
| `addMoveInItem` | `itemName`, `category`, `budgetINR?`, `needs?` |
| `markInterestPaid` | `interestID`, `paidOn` |

A date is `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (no seconds, no zone: Asia/Kolkata),
and it must be a real date and time. `budgetINR` is a number of rupees, 0 or
more. An id is a non-empty string of at most 200 characters, passed on as the
context wrote it.

The hub checks shapes and limits and nothing else; it cannot know whether an
id exists or an end falls after its start, so the app validates again against
its own data and shows only what passes. What the hub does to Claude's reply
(`normalizeAssistant` in `app-jobs.js`):

- An action whose `kind` was not in the request's `actions`, or is not a kind
  at all, is dropped. So is one with a missing or malformed required field, a
  malformed optional field that is present (a bad `due` is never turned into
  "no due date"), or no `why`. A field the kind does not take is left out.
- Text is cut to its limit with an ellipsis: `answer` 2,000, `why` and `title`
  and `itemName` 200 (folded to one line), `notes` 1,000, `category` 100,
  `needs` 500. An id is never cut: one that is too long drops its action.
- More than 8 valid actions are cut to 8.
- `dropped` is how many of Claude's proposed actions are not in `actions` for
  any of these reasons. It is always present (0 when nothing was removed), so the
  app can tell the owner that something was left out.
- A reply with no usable answer (an empty or missing `answer`, or `actions`
  that is not an array) is retried once like a schema miss, and then fails the
  job: `status` is `failed`, `result` is `null` and `error` is
  `the answer did not match the schema after one retry: answer: expected a non-empty string, got undefined`.
  A reply that is JSON wrapped in prose or a code fence is read like any other.

Claude is told to answer only from the context and say when it does not know, to
propose a change only when the question asks for one, to copy ids exactly as the
context writes them, and to leave an action out when the context has no id for
the item. The same table of kinds and fields generates the CLI's
`--json-schema` (one object per allowed kind), the prompt's list of fields
and the checker, so they cannot disagree.

Extraction rules for a StatementExtraction. They live in the fixed system
prompt (`STATEMENT_SYSTEM`) and the schema, and `test/app-jobs.test.js` pins
each one:

- `periodStart`, `periodEnd`, `statementDate` and `dueDate` are filled only when
  the statement prints them, and are never derived from transaction dates. A
  statement with no printed billing period has `null` there.
- The balance totals (`openingBalance`, `totalDue`, `minimumDue`) are signed
  from the cardholder's side: an amount the cardholder owes is positive, and a
  balance printed as credit (`Cr`, "credit balance", "NO PYMT REQD") is
  negative. `purchases`, `payments`, `creditLimit` and `availableLimit` are
  positive amounts as printed. A transaction's `amount` is always positive;
  `direction` carries the sign.
- `rewardLines` holds only rewards earned or credited in this statement
  (cashback credited, points earned this period, value-back credited), each as
  printed. Opening, closing and available balances go only in `rewardSummary`,
  so a consumer can sum `rewardLines` without counting a balance twice.
- `channel` for a UPI-paid row is never `unknown`: `upi-online` when the
  merchant is an online service or app (food delivery, quick commerce,
  e-commerce, subscriptions, travel booking, bill payments), otherwise
  `upi-scan` (physical shops, restaurants, fuel stations, small merchants). A
  card payment made on a website or app is `online`; a card-present payment is
  `pos`, and `contactless` only when the statement says so.
- `paidVia` (nullable, one per transaction) is the route a payment took:
  `airtel-thanks` (the description shows Airtel Thanks or Airtel Payments Bank),
  `amazon-pay` (a bill or partner payment through Amazon Pay), `smartbuy` (HDFC
  SmartBuy), `upi` (a UPI-paid row), else `null`. `card-direct` is in the
  vocabulary but the prompt does not ask for it. Like the other vocabularies the
  checker accepts a string it does not know. A row paid through Airtel Thanks
  has category `telecom`, unless its description clearly names an electricity,
  gas or water biller (`utilities`).
- `merchantKey` drops payment-aggregator prefixes and legal suffixes, so
  `PTM*ZOMATO`, `ZOMATO LIMITED` and `ZOMATO` all give `zomato` (likewise
  swiggy, blinkit, amazon, apple, airtel).

Conventions the shapes follow:

- Every key is present. A fact the source does not state is `null`, never 0.
- The checker rejects wrong types but accepts unknown vocabulary strings, such
  as a category the app has not heard of. The app maps those to its fallback.
  The exceptions are the fields something branches on: a transaction's
  `direction` and `kind`, and a terms card's `status`. An unknown word there
  would be read as a default and silently change the result, so it fails the
  check and the job retries like any other schema miss.
- `rate` is a fraction (0.25 = 25%). `Cap.percent` and `Fee.percent` are
  percentages (1 = 1%). Points are `pointsPer` per `perINR` rupees.
- `priority`: the higher number wins. The base rule is 0.
- `Cap` carries a `sourceUrl` like the other rule parts, so every cap can be
  cited. A cap limits rupees (`amountINR`) on a cashback rule and points
  (`points`) on a points rule; the other is `null`.
- Beyond the original spec, and matching the app's rule models: `Cap.points`
  and `Cap.note`, `Milestone.repeatReward` (what each further
  `repeatEveryINR` step pays, `null` when it pays the same as `reward`),
  `Milestone.note`, `Milestone.reward.rate` (a rate-boost's total cashback rate,
  a fraction), `Fee.note`, and `creditLagDays` (days after a cycle ends that
  its reward is normally credited). A `Fee.percent` of `null` is a fee whose
  rate the sources do not state. A cap or milestone `period` the sources do not
  give is `unknown`.
- The app's models and this shape must agree. `test/app-jobs.test.js` reads the
  app's bundled `CardRulesCatalog.json` and fails if any rule set in it uses a
  field or vocabulary string this shape lacks. It skips when the file is not
  there (as in CI); set `APP_CARD_CATALOG` to point at it.
- In a terms result, `sources` (how each URL was fetched, `direct` or `safari`,
  and why one failed), `checkedOn` and `cardKey` come from the bridge, not
  the model. Every link inside a `ruleSet` must be one of that card's
  requested sources: a `sourceUrl` that is not (compared without its
  fragment) becomes `null`, a `ruleSet.sources` entry that is not is dropped,
  and the card's `notes` say how many were removed. A source page is
  untrusted, so this keeps one from putting its own link in front of the
  owner. A card whose sources could not be read at all is
  `status: "failed"` with a null `ruleSet`, and Claude is not run for it.

## How a job runs

Every job runs the Claude CLI headless with:

```text
claude -p --output-format json --model <model> --restricted
       --strict-mcp-config --mcp-config '{"mcpServers":{}}'
       --no-session-persistence --permission-mode dontAsk
```

At startup the hub runs `claude --help` and `claude --version` once and checks
that `--restricted`, `--tools`, `--json-schema` and `--no-session-persistence`
are all there. Heroku installs `@anthropic-ai/claude-code` at `latest`, so a
release that drops or renames one would otherwise fail every job with an
unexplained CLI exit. Jobs submitted while the probe runs (it took 0.2 s with
Claude Code 2.1.322) wait in the queue. If a flag is missing, the queued jobs
fail and every later `POST /app/jobs` gets 503, each with an error that names
the missing flags, until the CLI is updated and the hub restarts.

The prompt goes on stdin and never in argv. With `--restricted`, the CLI
ignores user, project and local settings files, so no host hook sees the
input, and it confines `Read` to the working directory. An empty
`--mcp-config` together with `--strict-mcp-config` means no MCP server starts.
`--no-session-persistence` keeps the transcript off disk. `--bare` is not
used, because it ignores `CLAUDE_CODE_OAUTH_TOKEN`.

- **Statement jobs** add `--tools ""` (no built-in tool at all),
  `--max-turns 4`, a fixed `--system-prompt` and `--json-schema`. They run in
  the system temp directory.
- **Assistant jobs** add `--tools ""`, `--max-turns 4`, a `--system-prompt` the
  hub writes and a `--json-schema` for the kinds the request allowed, and run
  in the system temp directory. The system prompt holds every rule: answer from
  the context only, propose changes only on request, the allowed kinds and their
  fields, the date format and Asia/Kolkata. The section, today's date (with its
  weekday), the allowed kinds, the context and the question go on stdin as
  data. The context sits between two lines carrying a token minted for that job,
  so text inside it cannot close the block and pose as the question, and the
  prompt calls it untrusted. The client cannot add an instruction, a kind
  or a field beyond those; it only supplies the question and the context.
- **Shopping jobs** run Claude twice, with the bridge's own fetching in
  between. First a planning run (`--tools ""`) is given the city, month,
  categories and the allowed hosts and proposes up to 3 pages per category,
  for example the shop's own search URL. The bridge keeps only https URLs on
  `BRIDGE_APP_SHOP_DOMAINS` (once each, at most 3 per category), fetches them
  as described under [Fetching sources](#fetching-terms-sources), and writes
  each page's text, cut at 200,000 bytes, to a `claude-app-job-*` temp
  directory. Then the answering run reads them with `--tools Read` (up to 12
  turns plus one per page) and fills the schema. With no allowlist there is
  no planning run and no page, and when no page could be read there is nothing
  to read: either way the answering run gets `--tools ""`, so it has no tool
  to look anything up with. If the planning run cannot produce a valid answer
  or runs out of time, the job goes on with no pages and `notes` says so; a CLI
  error fails the job. The temp directory is removed when the job ends,
  however it ends.
- **Terms jobs** fetch each source in the bridge first, then add
  `--tools Read --max-turns 24`. Each card runs in its own
  `claude-app-job-*` temp directory, which is removed when the card ends: on
  success, failure, DELETE, or the hub stopping.

The model is `sonnet` unless the request names one. Names are shape-checked
before they reach argv.

If the answer does not match the schema, the job retries once. The errors are
appended to stdin, and they name paths and types (`transactions[3].amount:
expected number, got string`), never values. A CLI error, such as a lost
login, is not retried. In a statement job its message becomes the job's
`error`. In a terms job it fails only that card, with the message in the
card's `notes`, and the job still ends `done` with the other cards' results.

### Fetching terms sources

The bridge fetches each source itself with `node:https`, without keep-alive.
Shopping jobs use the same fetcher with `BRIDGE_APP_SHOP_DOMAINS` as the
allowlist, so everything below holds for them too, except the Safari
fallback, which shopping never uses: a retail page loaded in the owner's
logged-in profile shows their account, and that would go to Claude with the
page.

- https only, with no credentials in the URL, and the host must be on the
  allowlist.
- Redirects are followed by hand, at most 5, and every hop is re-checked
  against the allowlist.
- Limits: 10 s to connect, 30 s in total, 8 MB decoded.
- A PDF is saved as it came, and Claude's `Read` takes PDFs. HTML is reduced
  to text. A page with almost no text without its scripts counts as a failed
  fetch.

### Safari fallback (off by default)

Set `BRIDGE_APP_SAFARI_FALLBACK=1` to turn it on. When it is on, a source whose
direct fetch failed can be read through the owner's Safari, but only if all
of these hold:

- The failure is one a browser can get past: an HTML page with almost no text
  until its scripts run, HTTP 403, 429 or 503, or a dropped connection. A
  refusal never goes to Safari: a redirect to a host off the allowlist, a
  non-https URL or redirect, or a URL carrying credentials. Neither does a
  timeout, an oversized body, a 404 or an unsupported content type.
- A Safari extension instance is polling the hub.
- The job has used fewer than 5 fallback pages, and the hub fewer than 20 in
  the last hour across all jobs.
- The card's 300 s are not used up. Every call to the extension is raced
  against the card's deadline, and DELETE stops the fallback at once.

Each job uses one tab. The first source that needs Safari opens it with
`newTab: true, active: false`, through the same routing as
`claude_safari_navigate`, so it opens in the owner's current window without
changing what that window shows. Later sources in the same job navigate that
same tab. The bridge reads the tab until it has text, and keeps the text
only if the tab's final URL is still https and on the allowlist. When the job
ends (done, failed, timed out or deleted), the bridge navigates the tab to
`about:blank`. **The bridge cannot close the tab**, because the extension has
no close operation, so a blank tab stays open in Safari until someone closes
it. Adding a close operation to the extension is a follow-up.

Before it re-navigates the tab for a later source, or blanks it at the end,
the bridge lists the open tabs. If the owner has switched to the job's tab
(it is now the one its window shows) or closed it, the bridge does not touch
it: the next source opens a fresh background tab, and the blanking is skipped,
so a page the owner is reading never changes under them. A tab abandoned this
way is the owner's to close. Stopping the hub with SIGTERM or SIGINT blanks
each running job's tab first and waits up to 2 s for the extension to answer;
a second signal ends the wait at once.

The fallback helps for bot walls and pages that render only with JavaScript.
It does not help for a PDF, because Safari's PDF viewer has no page text to
read.

**What the app token can make Safari do when the fallback is on.** A holder
of the app token can submit terms jobs that make the owner's Safari:

- open one background tab per job, in the owner's current window and
  profile, without switching to it;
- load in that tab the job's own source URLs (https, host on
  `BRIDGE_APP_FETCH_DOMAINS`), and only after the hub's own fetch of that URL
  failed as above: at most 5 pages per job and 20 per hour;
- read that tab's text, which is written to the card's temp directory and
  read by Claude;
- load `about:blank` in that tab when the job ends.

It cannot pick another tab, click, type, run scripts, take screenshots or
read any other tab. Two things still reach beyond the allowlist and the
public web. The page loads in the owner's logged-in profile with its cookies,
and the extension's read of a background tab may refetch the URL with
`credentials: include`. And a listed page can redirect the tab to any site
before the bridge sees the final URL: Safari will have loaded that site even
though the bridge throws its text away. Turn the fallback on only with an
allowlist of hosts that serve public terms pages.

## Limits

| | |
| --- | --- |
| Running at once | 2, of which at most 1 terms or shopping job (a later statement or assistant job starts ahead of a waiting one) |
| Queued | 20 (429 beyond) |
| Statement job | 240 s, retry included |
| Assistant job | 100 s from submission, queue time and the retry included (the app stops waiting at 120 s); a job that waited that long in the queue fails without a CLI run |
| Terms job | 300 s per card: fetching, the Safari fallback and Claude included |
| Safari fallback | off by default; 5 pages per job, 20 per hour across jobs |
| Purge | 15 min after a job finishes |
| Request body | 2 MB |
| Statement text | 200,000 characters |
| Terms job | 10 cards, 5 sources each, `current` at most 200,000 characters of JSON |
| Shopping job | 10 min in all, planning included (2 min to choose pages, 4 min to fetch them; pages not yet read after that are skipped) |
| Shopping request | 12 categories, 3 pages per category, `prompt` at most 4,096 characters |
| Shopping pages | 120 requested per rolling hour across every job; a job's remaining pages are skipped once it is used up |
| Assistant request | `question` 2,000 characters, `context` 12,000 (413 beyond), at most 8 actions in the result |

Measured on 2026-11-15 with Claude Code 2.1.322 and `sonnet` on a Mac: a
synthetic one-page statement with ten transactions took 18 s, and one card
from a single 0.5 MB T&C PDF took 22-24 s. Both validated on the first
attempt.

## Privacy

- Jobs, their inputs and their results live in memory only, and a hub
  restart loses them. The input is dropped once the job finishes.
- Statement text goes to the CLI on stdin. It is never in argv, which any
  process on the host can read through `ps`, and the bridge never writes it to
  disk. The transcript is not persisted.
- The log line for a job carries its id, type, input size, duration, attempt
  count, output size and status, never text or results. The CLI's stderr is
  discarded unread, because it can echo its input.
- The app masks card numbers and personal details before upload. The
  statement prompt tells Claude to keep them masked.
- A shopping request holds a city, a month, product categories and the
  buyer's constraints and extra prompt: no statement data. They are held in
  memory while the job lives, go to the CLI on stdin, are dropped when it
  finishes, and are never logged (the log line carries the job id, sizes,
  durations, page counts and status). Search terms built from the categories
  do reach the retail sites the hub fetches from, from the hub's address, with
  no cookies or credentials.
- An assistant request holds the owner's question and a digest of the app's
  data, whatever the app chooses to put in it (it masks identifiers to their
  last four characters before upload). It is held in memory while the job lives,
  goes to the CLI on stdin, is dropped when the job finishes and is never
  logged: the log line carries the job id, the section, the sizes of the
  question and the context, the number of allowed kinds, durations, attempts,
  the output size and the status. The answer stays in the job until it is
  deleted or purged.
- A terms job's request holds no statement data: only source URLs, the
  card's names and the current rule set. The hub fetches sources itself,
  with no cookies or credentials, so with the Safari fallback off (the
  default) only public pages reach Claude.
- With the Safari fallback on, a fallback page loads in the owner's
  logged-in Safari profile with its cookies, and the extension's read may
  refetch it with `credentials: include`. Whatever that page shows a signed-in
  owner (a name, an account banner, an offer tied to their account) goes into
  the card's source text and to Claude. Keep the allowlist to hosts whose
  terms pages are public, or leave the fallback off.
