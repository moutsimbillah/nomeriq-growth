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
import { listProspects } from "@/lib/services/prospects";
import { listResearchJobs } from "@/lib/services/research";
import {
  Card,
  CategoryList,
  EmptyState,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import { AddLeadButton } from "@/components/lead-actions";
import { formatDate, relativeTime } from "@/lib/utils";
import { CATEGORIES, PIPELINE, PIPELINE_LABELS, type Category } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    category?: string;
    qualification?: string;
    job?: string;
  }>;
}) {
  const params = await searchParams;
  const [prospects, jobs] = await Promise.all([
    listProspects({
      query: params.q,
      status: params.status,
      category: params.category,
      qualification: params.qualification,
      jobId: params.job,
      limit: 150,
    }),
    listResearchJobs(),
  ]);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const activeFilterCount = [
    params.q,
    params.status,
    params.category,
    params.qualification,
    params.job,
  ].filter(Boolean).length;

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
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <UsersRound size={13} />
          <strong className="font-bold text-ink">{prospects.length}</strong>
          {prospects.length === 1 ? "business" : "businesses"}
          {activeFilterCount > 0 && " matching your filters"}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-faint">
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
            <table className="table">
              <thead>
                <tr>
                  <th className="w-[28%]">Business</th>
                  <th>Markets</th>
                  <th>Contact</th>
                  <th>Stage</th>
                  <th>Next action</th>
                  <th className="text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {prospects.map((prospect) => (
                  <tr key={prospect.id}>
                    <td>
                      <Link href={`/leads/${prospect.id}`} className="group flex items-start gap-2.5">
                        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-paper text-[11px] font-bold text-forest">
                          {prospect.businessName.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-ink group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-4">
                            {prospect.businessName}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-faint">
                            <Globe2 size={9} />
                            {prospect.country || "Country unknown"}
                            {prospect.domainKey ? ` · ${prospect.domainKey}` : ""}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <CategoryList categories={prospect.categories} limit={2} />
                    </td>
                    <td>
                      {prospect.contactEmail ? (
                        <div>
                          <div className="flex items-center gap-1 text-[11px] text-ink">
                            <MailCheck size={11} className="text-forest" />
                            <span className="max-w-[190px] truncate">
                              {prospect.contactEmail}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[9.5px] text-faint">
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
                      <span className="line-clamp-2 max-w-[200px] text-[10.5px] leading-4 text-muted">
                        {prospect.nextAction || "—"}
                      </span>
                    </td>
                    <td className="text-right">
                      <div className="text-[10px] text-faint">
                        {relativeTime(prospect.updatedAt)}
                      </div>
                      {prospect.researchJobId && jobsById.get(prospect.researchJobId) && (
                        <div className="mt-1 max-w-[130px] truncate text-[9px] text-faint/80">
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

      {prospects.length > 0 && (
        <div className="mt-4 flex items-center justify-between text-[10px] text-faint">
          <span>
            Showing up to 150 prospects. Use search and filters to narrow the
            database.
          </span>
          <span>Updated {formatDate(new Date())}</span>
        </div>
      )}
    </div>
  );
}
