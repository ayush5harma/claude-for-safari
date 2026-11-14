# App jobs (`/app/*`)

The hub can run two kinds of extraction job for a native companion app (for
example a personal-finance app on a phone): it turns masked credit card
statement text into structured rows, and it turns a card's published terms
and conditions into a reward rule set. The app submits a job, polls it, and
deletes it after reading. The logic lives in `bridge/app-jobs.js`; the bridge
loads it only when `BRIDGE_APP_TOKEN` is set.

Jobs are asynchronous because Heroku's router drops a request that stays
silent for 30 seconds, and a real statement, or a terms job with several cards,
takes longer than that.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_APP_TOKEN` | unset | Turns `/app/*` on. Without it every `/app/*` route answers 404. At least 16 characters and different from `BRIDGE_TOKEN`, or the hub refuses to start. |
| `BRIDGE_APP_FETCH_DOMAINS` | empty | Hosts a terms job may fetch from, comma- or space-separated, matched exactly against the URL's host (`www.bank.example` does not admit `bank.example`, and a non-default port is part of the host). Empty means terms jobs are refused. |

Mint the token the same way as `BRIDGE_TOKEN` (`openssl rand -hex 24`). On
Heroku, set both as config vars ([HOSTING.md](../HOSTING.md)); the deploy
script ships `app-jobs.js` beside the bridge. `install.sh` does not copy these
two variables into the launchd plist, so a local hub that should serve the
app needs them in its own environment.

## Authentication

- `/app/*` accepts only `Authorization: Bearer <BRIDGE_APP_TOKEN>`.
  `BRIDGE_TOKEN` gets 401 there.
- `BRIDGE_APP_TOKEN` gets 401 on every other route, including on a loopback
  hub that has no `BRIDGE_TOKEN`. A leaked app token cannot reach the browser
  tools, the chat panel or the MCP routes.
- A request that carries `Origin` or `Sec-Fetch-Site` gets 403. Browsers send
  one of the two on every request and a native client sends neither, so a web
  page that learns the token still cannot use it.
- Responses carry `Cache-Control: no-store`.
- The hub removes `BRIDGE_APP_TOKEN` from the environment it passes to panel
  turns, and a job's child gets no `BRIDGE_*` variable at all.

## Routes

`GET /app/health` is the app's "test connection". It returns
`{ ok, types, defaultModel, fetchDomains, running, queued, limits }`.

`POST /app/jobs` returns `202 {"jobId": "<uuid>", "status": "queued"|"running"}`.
Validation failures return 400 with an `error` string. An oversized body or
text returns 413, and a full queue returns 429.

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

`GET /app/jobs/<jobId>` returns:

```json
{ "jobId": "…", "type": "statement-extract", "status": "queued|running|done|failed",
  "progress": { "done": 0, "total": 1 }, "result": null, "error": null,
  "createdAt": "<ISO 8601>", "finishedAt": null }
```

`result` is set only when `status` is `done`, and `error` only when it is
`failed`. For a terms job, `progress.total` is the number of cards.

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

Conventions the shapes follow:

- Every key is present. A fact the source does not state is `null`, never 0.
- The checker rejects wrong types but accepts unknown vocabulary strings, such
  as a category the app has not heard of. The app maps those to its fallback.
- `rate` is a fraction (0.25 = 25%). `Cap.percent` and `Fee.percent` are
  percentages (1 = 1%). Points are `pointsPer` per `perINR` rupees.
- `priority`: the higher number wins. The base rule is 0.
- `Cap` carries a `sourceUrl` like the other rule parts, so every cap can be
  cited.
- In a terms result, `sources` (how each URL was fetched, `direct` or `safari`,
  and why one failed), `checkedOn` and `cardKey` come from the bridge, not
  the model. A card whose sources could not be read at all is
  `status: "failed"` with a null `ruleSet`, and Claude is not run for it.

## How a job runs

Every job runs the Claude CLI headless with:

```text
claude -p --output-format json --model <model> --restricted
       --strict-mcp-config --mcp-config '{"mcpServers":{}}'
       --no-session-persistence --permission-mode dontAsk
```

The prompt goes on stdin and never in argv. With `--restricted`, the CLI
ignores user, project and local settings files, so no host hook sees the
input, and it confines `Read` to the working directory. An empty
`--mcp-config` together with `--strict-mcp-config` means no MCP server starts.
`--no-session-persistence` keeps the transcript off disk. `--bare` is not
used, because it ignores `CLAUDE_CODE_OAUTH_TOKEN`.

- **Statement jobs** add `--tools ""` (no built-in tool at all),
  `--max-turns 4`, a fixed `--system-prompt` and `--json-schema`. They run in
  the system temp directory.
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

The bridge fetches each source itself with `node:https`, without keep-alive:

- https only, with no credentials in the URL, and the host must be on the
  allowlist.
- Redirects are followed by hand, at most 5, and every hop is re-checked
  against the allowlist.
- Limits: 10 s to connect, 30 s in total, 8 MB decoded.
- A PDF is saved as it came, and Claude's `Read` takes PDFs. HTML is reduced
  to text. A page with almost no text without its scripts counts as a failed
  fetch.

**Safari fallback.** When a direct fetch fails and a Safari extension
instance is polling the hub, the bridge opens the URL in a **background**
tab. It goes through the same routing as `claude_safari_navigate` with
`newTab: true, active: false`, so it opens in the current window without
changing what that window shows. The bridge then reads that tab until it has
text, and it keeps the text only if the tab's final URL is still on the
allowlist. This helps for bot walls and pages that render only with
JavaScript. It does not help for a PDF, because Safari's PDF viewer has no
page text to read. **The bridge cannot close that tab** (the extension has
no close operation), so it stays open in Safari until someone closes it.

## Limits

| | |
| --- | --- |
| Running at once | 2 |
| Queued | 20 (429 beyond) |
| Statement job | 240 s, retry included |
| Terms job | 300 s per card, fetching included |
| Purge | 15 min after a job finishes |
| Request body | 2 MB |
| Statement text | 200,000 characters |
| Terms job | 10 cards, 5 sources each, `current` at most 200,000 characters of JSON |

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
- A terms job sends nothing private: only public URLs, the card's names and
  the current rule set.
