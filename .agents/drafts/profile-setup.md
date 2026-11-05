# .agents/drafts/profile-setup.md — the Growth profile (item 2)

## What it is

A separate Hermes profile named `growth`, scoped to the Growth repo, so Growth work never
touches the main Nomeriq platform project or the global toolchain it relies on.

## Commands (founder reviews, then they run — or I run after approval)

```
hermes profile create growth --no-alias --no-skills \
  --description "Growth outreach portal ops: deploys, live checks, safe restores."
```

- `--no-skills` → the profile starts empty; it does not get 40+ bundled skills it will
  never use (cheaper prompt, no skill index noise).
- `--no-alias` → no wrapper script, so nothing global changes.
- `--clone` is deliberately **not** used: it would copy the main profile's `.env`, which
  carries the platform project's credentials into a Growth-scoped context.

## Then, inside the profile only

```
hermes -p growth config set model.provider custom
hermes -p growth config set model.default deepseek-v4.1
hermes -p growth config set terminal.cwd "D:/DeepSeek Nomeirq3.5/Nomeriq Leads"
```

Credentials are inherited from the shell environment / the shared `.env` unless keys are
placed in the profile. **Decide before creating**: whether the Growth profile gets its own
`HERMES_CUSTOM_*` keys (isolated billing) or inherits (shared). My recommendation: give it
its own `HERMES_CUSTOM_NOMERIQTOKENHAR_API_KEY` entry, so Growth runs never spend the main
profile's quota.

## The toolchain-isolation problem (important, unresolved)

A Hermes *profile* separates config, memory, sessions, cron and skills. It does **not**
separate `npm`/`node`: both profiles run the same machine-wide Node install. The main
Nomeriq platform project depends on its npm version (repo rule 10 pins npm 10.9.x because
npm 11 writes a broken lockfile). So the profile keeps Growth's *files* and *agent state*
apart, but a global `npm` change still affects both. Options if you want true isolation:

- **A**: nothing further — rely on `.npmrc` + `engine-strict=true` (already in the repo),
  which makes the wrong npm fail loudly in both projects. Cheapest, already in place.
- **B**: pin Growth's npm with a repo-local `.npmrc` + a dedicated Node via `nvm` used only
  in Growth terminal sessions. More setup, real isolation.

My recommendation: **A**. The repo already fails closed on a wrong npm, and B adds a second
Node install to keep patched.
