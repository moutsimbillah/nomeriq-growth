# .agents/drafts/daily-check.md — the scheduled read-only live check (item 6)

## Shape

- **Script job, not an agent job.** `hermes cron create ... --no-agent --script growth-live-check.sh`
  runs the script on schedule and delivers its stdout **verbatim** — zero LLM calls, zero
  credits per run. The script prints nothing when everything is healthy (cron treats empty
  stdout as silent), and prints the failed assertions when it is not.
- **Correction to an earlier note of mine**: cron silent-suppression also exists for
  *agent* jobs via a `[SILENT]` sentinel in the final response. I am still choosing the
  `--no-agent` script job: it costs nothing, cannot drift, and cannot decide to "helpfully"
  change something.
- The script is a **read-only** check. Its approvals stay `deny` (`approvals.cron_mode: deny`
  already). It never writes, restarts, migrates or sends.

## Commands

```
mkdir -p ~/AppData/Local/hermes/scripts
cp .agents/drafts/growth-live-check.sh ~/AppData/Local/hermes/scripts/

hermes cron create "0 8 * * *" "Growth daily read-only live check" \
  --name growth-daily-live-check \
  --script growth-live-check.sh --no-agent \
  --timezone Asia/Karachi --deliver local

hermes cron create "0 9 * * 1" "Growth weekly summary" \
  --name growth-weekly-summary \
  --script growth-weekly-summary.sh --no-agent \
  --timezone Asia/Karachi --deliver local
```

`--deliver local` is a placeholder: it becomes the Discord home channel once the bot token
is in (item 7). Until then it lands in the local session, which is where you are already
reading.

## Why `--no-agent`

An agent-backed monitoring job wakes an LLM every run to be told "nothing is wrong" — that
is the single biggest recurring credit cost in this setup. The script asserts the same
things deterministically. If a check needs judgement, it prints the raw evidence and I read
it; that is rarer and cheaper than paying for a model to do it every morning.

## What it reports

Nothing, when healthy. When not: the failed assertion, the value observed, and the
counts leads/verified/drafts/messages. Counts only — never a lead name, email or message body.

## The weekly summary script

Same shape, different content: last 7 days of checks, the counts trend, deploy history
(`git log --oneline -10`), timer/backup health, and any incident from `hermes cron incidents`.
Weekly is genuinely useful to read; daily noise is not, which is why daily is silent-unless-broken.
