# .agents/drafts/model-and-fallback.md — cost and reliability (item 8)

## What is true right now

- Primary model in `config.yaml` is `gpt-6.1-sol` via `openai-codex` OAuth; this session
  is running on **`deepseek-v4.1` via provider `vyceai`**.
- The Codex OAuth credential is **rate-limited right now** (`usage_limit_reached (429)`).
- `hermes fallback list` → **"No fallback providers configured."** That is why your provider
  interruptions killed turns: the log has `Empty response … after 3 retries. No fallback
  available.` and `main provider custom is unavailable and no fallback_chain /
  fallback_providers is configured — refusing to guess another logged-in provider.`
- `auxiliary.compression` had no explicit provider, so compression inherited the main route.

## What I measured (live probes, no keys printed)

| Route | Result |
| --- | --- |
| `vyceai` / `deepseek-v4.1` | working (this session) |
| `nomeriqtokenhar` / `deepseek-v4.1-flash:free` | working, ~0.7s, **emits tool calls** |
| `tokenharbor` / `deepseek-v4.1-flash:free` | working, ~3.2s, emits tool calls |
| `tokenharborelitrades980` | free allowance exhausted until 10 Nov 2026 |
| `gemini-3.8-flash`, `grok-4.6`, `glm-5.3` on these accounts | "No active plan was found on this account" |
| `deepseek-v4.1-flash:free` context window | 1,048,576 tokens (1M) |
| paid `deepseek-v4.1-flash` | $0.30 in / $1.20 out per 1M |
| `glm-5.3-flash` | $0.15 in / $0.50 out per 1M |

**Tool calling tested explicitly** — a fallback that cannot call tools would break the agent
loop mid-turn. `deepseek-v4.1-flash:free` emitted a real `tool_calls` payload on three
separate accounts.

## The exact config change

Append to `~/.hermes/config.yaml` (top level, no duplicate keys):

```yaml
fallback:
  min_switch_reset_seconds: 0
fallback_providers:
  - provider: nomeriqtokenhar
    model: deepseek-v4.1-flash:free
  - provider: custom
    model: deepseek-v4.1-flash:free
    base_url: https://tokenharbor.ai/v1
    key_env: HERMES_CUSTOM_ROOHANTOKENHAR_API_KEY
  - provider: custom
    model: deepseek-v4-flash:free
    base_url: https://tokenharbor.ai/v1
    key_env: HERMES_CUSTOM_HUZAIFATOKENHAR_API_KEY
```

**Verified** against a scratch Hermes home with the real loader: `hermes fallback list`
reads back all three entries in order — `deepseek-v4.1-flash:free (via nomeriqtokenhar)`,
then `(via custom) [https://tokenharbor.ai/v1]`, then `deepseek-v4-flash:free`. A config
`hermes config set` cannot write this shape (a list of dicts); it has to be the YAML edit.

Then, for cheap subagents and compression:

```
hermes config set delegation.provider nomeriqtokenhar
hermes config set delegation.model "deepseek-v4.1-flash:free"
hermes config set delegation.reasoning_effort low
hermes config set auxiliary.compression.provider nomeriqtokenhar
hermes config set auxiliary.compression.model "deepseek-v4.1-flash:free"
```
(All five verified against a scratch home; `hermes config get delegation` / `get auxiliary`
read them back correctly.)

## Expected effect on credits

- **Fallback**: no change in the happy path. When the primary dies mid-turn you lose the
  prompt-cache prefix (the docs are explicit: a switch re-reads the whole history at full
  input price). That is the price of not losing the turn.
- **Delegation on `:free`**: subagent work stops touching the paid model at all. A big
  fan-out that costs real money today costs **$0** for the child turns, bounded by the free
  allowance. Quality is lower than the main model — which is why the plan keeps verification
  with me, on the main model.
- **Compression on `:free`**: compression is a large-input call every time context fills;
  that was a meaningful share of spend and becomes $0.
- **`reasoning_effort: low` on children**: fewer hidden tokens per child.
- Two honest caveats: (1) `:free` allowances are rate-limited and shared, so a large
  parallel fan-out can hit the ceiling and fall back; (2) the free tier's data-handling
  terms are not the paid provider's — do not route anything sensitive through it.

## Item 4 (sudo prompt) — the two options, in plain words

The problem: when a command's text contains a **heredoc body line that begins with the
privileged word** (e.g. `ssh host 'bash -s' <<'SH'` then a line starting `sudo -u growth …`),
Hermes misreads that line as a *local* privileged command and raises a local password prompt
for work that actually runs on the server. I reproduced it on the installed code: that shape
counts 1 (prompt fires); the same command written as a single quoted one-liner counts 0.

- **Option A — patch the installed file.** A ~36-line change in
  `tools/terminal_tool_sudo.py` that teaches the scanner to treat a heredoc body as opaque
  (it is the child program's stdin, not shell syntax). `git apply --check` says it applies
  cleanly to the current commit. It also fixes a latent correctness bug: today that same
  misfire *rewrites* the remote script text, not just prompts. Cost: it is a local patch of
  an installed file, so `hermes update` will **skip** updating while the tree is dirty
  (it skips rather than clobbers — safe, but it keeps skipping until the patch is upstreamed
  or reverted). Requires a gateway restart to load.
- **Option B — change how deploys are written, patch nothing.** Route every privileged
  remote step as a script: `ssh host 'sudo -n bash /tmp/<script>.sh'`. No inner line starts
  with the privileged word, so the misfire never fires, no local patch, nothing to maintain.
  Cost: the constraint lives in the skills rather than in the code, and it can be violated
  by accident by writing a heredoc.

**My recommendation: B.** It costs nothing, it is already written into the three skills, and
it avoids carrying a local patch of an installed file through every future update. Take A
only if you want the underlying bug gone regardless of how commands are written — and if you
do, I would suggest the same change go upstream rather than live only on this machine.
