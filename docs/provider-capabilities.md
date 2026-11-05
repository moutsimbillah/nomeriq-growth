# Provider capabilities — web search and page fetching

Researched 2026-11-06 from each provider's own documentation, as the plan's item 3 requires, before any
of it is wired. This is a snapshot: the docs move, so re-check before changing a provider's shape.

The reason this matters here is that the portal separates *the model* from *the search source*. For
some providers search is a standalone API the portal calls itself; for others it is a capability of
the model, performed server-side during a generation. That difference decides which combinations are
possible, and it is why the matrix has two columns rather than one.

## The matrix

| Provider | Server-side web search | Server-side page fetch | Shape |
| --- | --- | --- | --- |
| **DeepSeek** | yes — own JSON API | yes — own JSON API | Standalone endpoints, independent of any model call |
| **OpenAI** | yes — hosted tool on the Responses API | **not documented** | Search rides inside a model call; no callable fetch |
| **Anthropic** | yes — server tool (`tools[]`) | yes — server tool | Both ride inside a model call; fetch takes one URL per call |
| **Google Gemini** | yes — built-in tool (`google_search`) | yes — built-in tool (`url_context`) | Both ride inside a model call; URLs go in the prompt |
| **OpenRouter** | yes — server tool `openrouter:web_search` | yes — server tool `openrouter:web_fetch` | Gateway: executes search/fetch server-side and injects results |

### DeepSeek — the only provider with a model-independent search and fetch

`https://api-docs.deepseek.com/guides/search/`, `.../api/search/`, `.../api/fetch/`

- Search: `POST https://api.deepseek.com/v1/tools/search`. Body: `query` (1–128 chars; supports
  `site:`, `-site:`, `-`, `-"..."`, `"..."`, `lang:`, `after:`, `before:`), `count` (1–50, default 10),
  `ori_question`, `localization`, `need_content` (default false).
- Search results carry `rerank_score` (0–3; ≥1.5 is high quality), `title`, `url`, `snippet`
  (100–200 chars, for a UI), `summary` (600–800 chars, meant to be read by a model), `content`
  (empty unless `need_content`), `site_name`, `site_icon`, `date`, `authority` (−1…4; ≥3 highly
  authoritative).
- Fetch: `POST https://api.deepseek.com/v1/tools/fetch`. Body is `url` alone (≤8192 chars, http/https,
  no credentials in the URL). Response: `{ title, content }` where **`content` is Markdown text**, not
  HTML.
- `summary` and `authority` are useful to the research pipeline: the summary is written for a model to
  read, and `authority` is a ready-made evidence signal that the current verifier derives by hand.

### OpenAI — search, but no documented fetch

`developers.openai.com` — web search guide, Responses API reference, chat completions reference

- Search: `POST https://api.openai.com/v1/responses` with `tools: [{"type": "web_search"}]`. Hosted and
  server-side: the model decides whether to search (`tool_choice: "required"` forces it). The response
  returns a `web_search_call` item (its `action.type` is `search`, `open_page` or `find_in_page`) and a
  `message` item whose `content[0].annotations` holds `url_citation` objects (url, title, start/end
  index). `include: ["web_search_call.action.sources"]` returns every URL consulted. Controls:
  `search_context_size` (low/medium/high), `filters.allowed_domains`/`blocked_domains` (≤100 each),
  `external_web_access`, `user_location`.
- `web_search_preview` is still accepted for older integrations but lacks `filters`,
  `external_web_access` and `return_token_budget`. New work uses `web_search`.
- **Fetch: not documented.** There is no tool or endpoint that takes a caller-chosen URL and returns
  its contents. `open_page` and `find_in_page` are *reporting* items describing what the model did
  inside its own search, not a callable fetch. Cross-checked against the documented hosted-tool list
  (web_search, file_search, image_generation, code_interpreter, hosted_shell, apply_patch, skills,
  computer_use, mcp, tool_search) — no fetch/browse/crawl tool exists.
- Legacy Chat Completions search exists via the `gpt-5-search-api` model and `web_search_options`.

### Anthropic — both, as versioned server tools

`platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool`, `.../web-fetch-tool`,
`.../tool-reference`

- Search: `{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}` in the request's
  `tools` array of `POST https://api.anthropic.com/v1/messages`. Newer versions
  `web_search_20260209` (dynamic filtering) and `web_search_20260318` (response-inclusion control).
  The API runs the search itself; results arrive as a `server_tool_use` block followed by
  `web_search_tool_result`, and text carries `web_search_result_location` citations. Usage is reported
  as `usage.server_tool_use.web_search_requests`. Documented price: **$10 per 1,000 searches**, one
  use per search regardless of results, failures not billed.
- Fetch: `{"type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 5}`, versions up to
  `web_fetch_20260318`. The server_tool_use input is `{"url": "..."}` — **one URL per call**, several
  calls may occur in one request. Result `web_fetch_result` carries `url`, `content` (text for HTML;
  base64 for PDFs) and `retrieved_at`. `max_content_tokens` truncates; `citations` are **off** by
  default here, unlike search.
- Errors arrive as HTTP 200 with `web_search_tool_result_error` and codes such as `max_uses_exceeded`,
  `too_many_requests`, `unavailable` — a shape the portal's error handling must not treat as success.

### Google Gemini — both, as built-in tools

`ai.google.dev/gemini-api/docs/...`, `ai.google.dev/api/interactions-api`, `.../api/generate-content`

- Search: `"tools": [{"google_search": {}}]` on
  `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, or
  `{"type": "google_search"}` on the newer `POST .../v1beta/interactions`. Fully server-side: the model
  generates queries, runs them and answers with citations (`url_citation` annotations).
- Fetch ("URL context"): `"tools": [{"url_context": {}}]` — **there is no standalone fetch endpoint**;
  the caller puts full URLs (with protocol) in the prompt and the model retrieves them. Up to **20 URLs
  per request**, **34MB** of retrieved content per URL, publicly reachable URLs only. Retrieved content
  is counted and billed as **input tokens**, unlike Search grounding.
- Retrieval is cache-first, then live fetch. A `status` of `unsafe` means the URL failed moderation.

### OpenRouter — the gateway, with a deprecation that matters

`openrouter.ai/docs/guides/features/server-tools/web-search`, `.../web-fetch`

- Search: `tools: [{"type": "openrouter:web_search", "parameters": {…}}]`. Server-side; the model
  decides whether to search (0–N per request). Parameters include `engine`
  (`auto|native|exa|firecrawl|parallel|perplexity`), `max_results` (1–25), `max_uses`,
  `search_context_size`, `max_characters`, `allowed_domains`/`excluded_domains`, `user_location`.
- Fetch: `tools: [{"type": "openrouter:web_fetch", "parameters": {…}}]`, engines
  `auto|native|exa|openrouter|firecrawl|parallel`; response `{url, title, content, status,
  retrieved_at}`; 50 fetches/request cap on the openrouter and native engines. Exa and Parallel cost
  $1 per 1,000 fetches; the OpenRouter engine is free; native is passed through.
- **Deprecated, and the portal must not build on them:** the `:online` model suffix and the `web`
  plugin (`plugins: [{"id": "web"}]`). The docs now say to use the `openrouter:web_search` server tool
  instead. Any OpenRouter support must use the server tools.

## The finding the founder must decide: DeepSeek's documented QPS ceilings moved

`api-docs.deepseek.com/guides/search/` states today:

| API | QPS limit |
| --- | --- |
| Search | **100** |
| Fetch | **25** |

Account-level, independent of each other and of the model concurrency limits; Fetch additionally has an
unpublished per-domain limit. Both over-limits return HTTP 429.

`AGENTS.md` rule 4 says "DeepSeek documents 5 requests per second per account for Search and for
Fetch", and the Settings UI, the settings validation and the database CHECK all refuse anything above 5.
**The rule's premise is stale** — the 5 QPS figure was the launch-day number (the guide was rewritten
when Search and Fetch opened up, change-log entry 2026-10-17). It now survives only in third-party
write-ups.

Nothing has been changed: the ceilings stay at 5 until the founder decides, because rule 4 also says
not to raise them. The choice is his:

1. **Leave the ceilings at 5.** Conservative, no code or migration, and it costs nothing at the current
   volume — the portal sends a handful of search requests per lead.
2. **Raise them to match the docs** (100/25), with a migration that widens the CHECK, new validation,
   and honest labels in Settings. More headroom for a large research job, but the portal would then be
   a heavier user of a shared account-level quota, and the number would have to be revisited whenever
   DeepSeek publishes a change.

Sibling billing fact, for the same reason: Search and Fetch are **$0.75 per 1,000 successful
requests** each — billed only when the request returns HTTP 200 and produces a result.
