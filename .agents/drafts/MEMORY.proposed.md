# Environment & Sub-Agent Knowledge

- **Coder sub-agent**: DeepSeek Harness (`dsh`) does only small mechanical chunks, never data-import or sending code (founder's rule); it goes silent and writes nothing on large tasks. `dsh-bridge` is a `.cmd` (bash cannot resolve it) and a missing command still exits 0 through a pipe, so always read the output. Exact invocation: the `deepseek-harness` skill.
- **Long prompts**: keep a task under ~7.5 KB.
- **Active project dir**: `D:\DeepSeek Nomeirq3.5\Nomeriq Leads`
§
Nomeriq Growth plan-of-record: `D:\DeepSeek Nomeirq3.5\<N> Nomeriq Growth — Independent System Plan.md/.pdf` (one level above the repo).
§
Decision rights (Nomeriq Growth): `.agents/charter.md` is the authority — read at session start with AGENTS.md. I own engineering and verification; the founder owns decisions. Alone: code/tests/local work, read-only live checks, subagents, skills, scheduled read-only jobs, non-force pushes on a docs/DEPLOYMENT.md deploy. Ask first: live-data writes, live migrations, email, mailbox connect, server deletes, force-push, money, secrets, editing AGENTS.md or the charter. Never turn approvals off.
§
Growth rules: the founder is not an engineer — bring decisions, not options dressed as questions. Never touch the main Nomeriq platform project or its npm/node. No Telegram (blocked in Pakistan); Discord is the report channel. Reports carry counts, never row contents. The server host key is known: never pass StrictHostKeyChecking=no.
§
Global git `credential.helper` here is Git for Windows' `helper-selector`, which hangs forever in agent sessions. Fix per repo: `git config --local --replace-all credential.helper ""` then `--add credential.helper wincred`; prove with `GIT_CURL_VERBOSE=1 git ls-remote origin` (401→Basic→200).
§
Growth server: Lightsail 'growth-portal', Mumbai ap-south-1, Ubuntu 24.04, 2 GB, IP 52.66.27.26, SSH user ubuntu, key C:\Users\Welcome\.ssh\LightsailDefaultKey-ap-south-1.pem (never print/copy/commit). App user 'growth'; ufw off — the Lightsail console firewall governs inbound ports.
§
- Never end a turn announcing future work ("starting now"): do it in that same turn, or say plainly that you are stopping.
