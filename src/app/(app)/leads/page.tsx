import Link from "next/link";
import {
  ArrowRight,
  Filter,
  Globe2,
  MailCheck,
  Search,
  SlidersHorizontal,
  UsersRound,
} from "lucide-react";
import { listEmailAccounts } from "@/lib/email/accounts";
import { defaultSenderLabel, NO_SENDER_LABEL, senderLabels, senderShortName } from "@/lib/email/senderPill";
import {
  getProspectOriginFacets,
  listProspectsPage,
  PROSPECT_PAGE_SIZE,
} from "@/lib/services/prospects";
import { AGENT_LABELS, AGENT_TAGS, CHANNEL_LABELS, CHANNEL_TAGS } from "@/lib/agent/agentTag";
import { countActiveFilters, leadFilterQuery, readLeadFilters } from "@/lib/leads/leadFilters";
import { ADDED_LABELS, COUNTED_ADDED_RANGES } from "@/lib/dates/pakistan";
import { listResearchJobs } from "@/lib/services/research";
import { getWorkspaceSettings } from "@/lib/services/settings";
import {
  AgentPill,
  Card,
  CategoryList,
  EmptyState,
  PageHeader,
  SenderPill,
  StatusBadge,
} from "@/components/ui";
import { AddLeadButton } from "@/components/lead-actions";
import { formatDate, relativeTime } from "@/lib/utils";
import { CATEGORIES, PIPELINE, PIPELINE_LABELS, type Category } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const settings = await getWorkspaceSettings();
  const filters = {
    ...readLeadFilters(params as Record<string, string | undefined>),
    timezone: settings.timezone,
    now: new Date(),
  };
  // The window is the query string's `limit`, so "Load more" only has to raise it. The service clamps
  // it to the true filtered total, which the header prints, so the loaded rows are never the total.
  const requestedLimit = Number.parseInt(params.limit ?? "", 10);
  const windowLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : PROSPECT_PAGE_SIZE;
  const [page, jobs, facets, senderProfiles] = await Promise.all([
    listProspectsPage({ ...filters, limit: windowLimit }),
    listResearchJobs(),
    getProspectOriginFacets(filters),
    listEmailAccounts(),
  ]);
  const prospects = page.rows;
  const total = page.total;
  const moreSearch = new URLSearchParams(leadFilterQuery(filters).replace(/^\?/, ""));
  moreSearch.set("limit", String(Math.min(page.limit + PROSPECT_PAGE_SIZE, total)));
  const loadMoreHref = `/leads?${moreSearch.toString()}`;
  const senderById = new Map(senderProfiles.map((account) => [account.id, account]));
  const senderLabelById = senderLabels(senderProfiles);
  const defaultProfile = senderProfiles.find((account) => account.isDefault) ?? senderProfiles[0] ?? null;
  const defaultLabel = defaultSenderLabel(defaultProfile);
  const senderPill = (profileId: string | null | undefined) =>
    profileId
      ? { id: profileId, label: senderLabelById.get(profileId) ?? senderShortName(senderById.get(profileId) ?? {}) }
      : { id: null, label: defaultLabel };
  // The pill says the domain; the tooltip carries the full address and the profile's own name.
  const senderTitle = (profileId: string | null | undefined) => {
    if (!profileId) {
      // A never-default mailbox is not a default, so this sentence must not promise it will send.
      if (defaultProfile?.neverDefault) {
        return `${NO_SENDER_LABEL} — no mailbox is the default, so pin a sending profile on this lead before emailing it`;
      }
      return defaultProfile
        ? `No sending profile yet — ${defaultProfile.emailAddress} (${defaultProfile.name}) is the default and will send`
        : "No sending profile yet, and no default mailbox is connected";
    }
    const account = senderById.get(profileId);
    return account ? `${account.emailAddress} — ${account.name}` : "Sending profile";
  };
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const activeFilterCount = countActiveFilters(filters);

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="The shared prospect database"
        title="Every business, one record."
        description="Search the entire Growth database before researching anything new. Website, email, aliases and social identities all protect the same record."
        actions={
          <>
            <AddLeadButton jobs={jobs} defaultJobId={params.job} />
            <Link href="/research" className="btn-primary">
              <Search size={14} />
              Research more
            </Link>
          </>
        }
      />

      <Card className="mb-4 p-3">
        <form className="flex flex-wrap items-center gap-2" method="GET">
          <div className="relative min-w-[220px] flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            />
            <input
              name="q"
              defaultValue={params.q || ""}
              className="input pl-9"
              placeholder="Search business, website, country or email…"
            />
          </div>
          <select
            name="status"
            defaultValue={params.status || ""}
            className="select w-auto min-w-[150px]"
          >
            <option value="">All stages</option>
            {PIPELINE.map((status) => (
              <option key={status} value={status}>
                {PIPELINE_LABELS[status]}
              </option>
            ))}
          </select>
          <select
            name="category"
            defaultValue={params.category || ""}
            className="select w-auto min-w-[130px]"
          >
            <option value="">All markets</option>
            {CATEGORIES.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
          <select
            name="qualification"
            defaultValue={params.qualification || ""}
            className="select w-auto min-w-[145px]"
          >
            <option value="">Qualification</option>
            <option value="verified">Verified</option>
            <option value="candidate">Incomplete candidate</option>
            <option value="rejected">Rejected</option>
          </select>
          <select
            name="hasEmail"
            aria-label="Has email"
            defaultValue={params.hasEmail || ""}
            className="select w-auto min-w-[145px]"
          >
            <option value="">Has email: Any</option>
            <option value="yes">Yes ({facets.hasEmail.yes})</option>
            <option value="no">No ({facets.hasEmail.no})</option>
          </select>
          <select
            name="job"
            defaultValue={params.job || ""}
            className="select w-auto min-w-[160px]"
          >
            <option value="">All research jobs</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.name.length > 34 ? `${job.name.slice(0, 34)}…` : job.name}
              </option>
            ))}
          </select>
          <select
            name="agent"
            defaultValue={params.agent || ""}
            className="select w-auto min-w-[160px]"
            title="Which agent saved the lead"
          >
            <option value="">All agents</option>
            {AGENT_TAGS.map((tag) => {
              const count = facets.agents[tag] ?? 0;
              return (
                <option key={tag} value={tag} disabled={count === 0 && params.agent !== tag}>
                  {AGENT_LABELS[tag]} ({count})
                </option>
              );
            })}
          </select>
          <select
            name="sender"
            defaultValue={params.sender || ""}
            className="select w-auto min-w-[150px]"
            title="Which sending profile the lead is tied to"
          >
            <option value="">All senders</option>
            {senderProfiles.map((account) => {
              const count = facets.senders?.[account.id] ?? 0;
              return (
                <option
                  key={account.id}
                  value={account.id}
                  disabled={count === 0 && params.sender !== account.id}
                >
                  {senderLabelById.get(account.id) ?? senderShortName(account)} ({count})
                </option>
              );
            })}
            <option
              value="default"
              disabled={(facets.senders?.default ?? 0) === 0 && params.sender !== "default"}
            >
              {defaultLabel} ({facets.senders?.default ?? 0})
            </option>
          </select>
          <select
            name="added"
            defaultValue={params.added || ""}
            className="select w-auto min-w-[150px]"
            title={`Added on — days are ${settings.timezone} days`}
          >
            <option value="">Any date</option>
            {COUNTED_ADDED_RANGES.map((range) => {
              const count = facets.added[range] ?? 0;
              return (
                <option key={range} value={range} disabled={count === 0 && params.added !== range}>
                  {ADDED_LABELS[range]} ({count})
                </option>
              );
            })}
            <option value="custom">
              {ADDED_LABELS.custom}
            </option>
          </select>
          <span className="flex items-center gap-1.5">
            <input
              type="date"
              name="from"
              defaultValue={params.from || ""}
              aria-label={`Added from, ${settings.timezone}`}
              className="input h-10 w-auto px-3 text-13"
            />
            <span className="text-12 text-muted">to</span>
            <input
              type="date"
              name="to"
              defaultValue={params.to || ""}
              aria-label={`Added to, ${settings.timezone}`}
              className="input h-10 w-auto px-3 text-13"
            />
          </span>
          <select
            name="channel"
            defaultValue={params.channel || ""}
            className="select w-auto min-w-[170px]"
            title="How the lead arrived"
          >
            <option value="">All channels</option>
            {CHANNEL_TAGS.map((tag) => {
              const count = facets.channels[tag] ?? 0;
              return (
                <option key={tag} value={tag} disabled={count === 0 && params.channel !== tag}>
                  {CHANNEL_LABELS[tag]} ({count})
                </option>
              );
            })}
            <option
              value="unknown"
              disabled={(facets.channels.unknown ?? 0) === 0 && params.channel !== "unknown"}
            >
              Unknown ({facets.channels.unknown ?? 0})
            </option>
          </select>
          <button type="submit" className="btn-secondary">
            <Filter size={13} />
            Apply
          </button>
          {activeFilterCount > 0 && (
            <Link href="/leads" className="btn-ghost">
              Clear
            </Link>
          )}
        </form>
      </Card>

      <div className="mb-2.5 flex items-center justify-between px-1">
        <div className="flex items-center gap-2 text-12 text-muted">
          <UsersRound size={13} />
          {/* The total is the whole filtered set, never the loaded rows: a capped page reads
              "Showing 150 of 578", and the capped number is never presented as the count. */}
          {total === 0 ? (
            <span>0 businesses</span>
          ) : (
            <span>
              Showing <strong className="font-bold text-ink">{prospects.length}</strong> of{" "}
              <strong className="font-bold text-ink">{total}</strong>{" "}
              {total === 1 ? "business" : "businesses"}
            </span>
          )}
          {activeFilterCount > 0 && " matching your filters"}
        </div>
        <div className="flex items-center gap-1.5 text-12 text-faint">
          <SlidersHorizontal size={11} />
          Sorted by most recently updated
        </div>
      </div>

      <Card className="overflow-hidden">
        {prospects.length === 0 ? (
          <EmptyState
            icon="sparkles"
            title={activeFilterCount ? "No leads match these filters" : "No leads yet"}
            description={
              activeFilterCount
                ? "Clear the filters or search a different identity."
                : "Start with a real provider, verify the paid signal service and public email, then save the evidence."
            }
            action={
              activeFilterCount ? (
                <Link href="/leads" className="btn-secondary btn-sm">
                  Clear filters
                </Link>
              ) : (
                <Link href="/research" className="btn-primary btn-sm">
                  Create a research target
                </Link>
              )
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table min-w-[640px]">
              <thead>
                <tr>
                  {/* Widths total 100%, sized so no cell and no header label has to clip at 1024: the
                      stage pill and the UPDATED header are the two that set the floor. */}
                  <th className="w-[16%]">Business</th>
                  <th className="w-[18%]">Agent</th>
                  <th className="w-[12%]">Markets</th>
                  <th className="w-[14%]">Contact</th>
                  <th className="w-[16%]">Stage</th>
                  <th className="w-[11%]">Next action</th>
                  <th className="w-[13%] text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {prospects.map((prospect) => (
                  <tr key={prospect.id}>
                    <td>
                      <Link href={`/leads/${prospect.id}`} className="group flex items-start gap-2.5">
                        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-paper text-12 font-bold text-forest">
                          {prospect.businessName.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-semibold text-ink group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-4">
                              {prospect.businessName}
                            </span>
                            {prospect.firstDraftAgent &&
                              prospect.sourceAgent &&
                              prospect.firstDraftAgent !== prospect.sourceAgent && (
                                <span
                                  title={`The draft was written by ${AGENT_LABELS[prospect.firstDraftAgent]}`}
                                  className="text-12 text-amber"
                                >
                                  ✎ draft by {AGENT_LABELS[prospect.firstDraftAgent]}
                                </span>
                              )}
                          </span>
                          <span className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-12 text-faint">
                            <Globe2 size={9} />
                            {prospect.country || "Country unknown"}
                            {prospect.domainKey ? ` · ${prospect.domainKey}` : ""}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="align-top">
                      <div className="flex flex-col items-start gap-1">
                        <AgentPill
                          agent={prospect.sourceAgent ?? "unknown"}
                          channel={prospect.sourceChannel}
                          note={prospect.sourceAgent === "other" ? prospect.sourceClient : undefined}
                        />
                        <SenderPill
                          profile={senderPill(prospect.sendingProfileId)}
                          title={senderTitle(prospect.sendingProfileId)}
                        />
                      </div>
                      {prospect.firstDraftAgent &&
                        prospect.sourceAgent &&
                        prospect.firstDraftAgent !== prospect.sourceAgent && (
                          <span
                            title={`The draft was written by ${AGENT_LABELS[prospect.firstDraftAgent]}`}
                            className="mt-1 block text-12 leading-tight text-amber"
                          >
                            ✎ draft by {AGENT_LABELS[prospect.firstDraftAgent]}
                          </span>
                        )}
                    </td>
                    <td>
                      {/* one market plus "+N": two pills cannot fit the column at 1024 without scrolling */}
                      <CategoryList categories={prospect.categories} limit={1} />
                    </td>
                    <td>
                      {prospect.contactEmail ? (
                        <div>
                          <div className="flex items-center gap-1 text-12 text-ink">
                            <MailCheck size={11} className="text-forest" />
                            <span className="max-w-[190px] truncate">
                              {prospect.contactEmail}
                            </span>
                          </div>
                          <div className="mt-0.5 text-12 text-faint">
                            Source confirmed
                          </div>
                        </div>
                      ) : (
                        <span className="badge border-amber/20 bg-amber/[0.06] text-amber">
                          No email
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={prospect.status} />
                    </td>
                    <td>
                      <span className="line-clamp-2 max-w-[200px] text-12 leading-4 text-muted">
                        {prospect.nextAction || "—"}
                      </span>
                    </td>
                    <td className="text-right">
                      <div className="text-12 text-faint">
                        {relativeTime(prospect.updatedAt)}
                      </div>
                      {prospect.researchJobId && jobsById.get(prospect.researchJobId) && (
                        <div className="mt-1 max-w-[130px] truncate text-12 text-faint/80">
                          {jobsById.get(prospect.researchJobId)?.name}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {page.hasMore && (
        <div className="mt-4 flex justify-center">
          <Link href={loadMoreHref} className="btn-secondary">
            Load more
          </Link>
        </div>
      )}

      {prospects.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-12 text-faint">
          <span>
            {page.hasMore
              ? `Load more to see the remaining ${total - prospects.length}.`
              : `All ${total} ${total === 1 ? "prospect" : "prospects"} shown.`}
          </span>
          <span>Updated {formatDate(new Date(), undefined, settings.timezone)}</span>
        </div>
      )}
    </div>
  );
}
