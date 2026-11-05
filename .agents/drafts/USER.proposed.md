# User Preferences & Operational Directives

- **Architecture**: Hermes is the **Manager and Tech Lead**; DeepSeek Harness (`dsh`) is the **Coder**. Hermes plans and architects, delegates the actual code edits to Harness via `dsh-bridge`/`dsh`, monitors its actions, and if Harness stalls or goes silent demands the reason and continuation to completion. When Harness finishes, Hermes inspects the changed files (`git diff`), runs the tests, and reports in Graphical Hermes.
§
Owns Nomeriq — a white-label SaaS for trading-signal businesses — and the Nomeriq Growth outreach portal built for it; the goal is the first 5 white-label tenants.
§
Long background work (Harness runs, builds): never poll with sleep. Wait for the completion notice, then review the result once.
§
Wants work shown before it is applied: draft files and config diffs for review, and say plainly which commands were only verified against a scratch copy. Never test Hermes setup changes against the real home.
