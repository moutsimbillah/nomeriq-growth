import Link from "next/link";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  FileText,
  History,
  Radar,
  ShieldCheck,
  Target,
  UsersRound,
} from "lucide-react";
import {
  getRecentResearchEvents,
  listResearchJobs,
} from "@/lib/services/research";
import { listEmailAccounts } from "@/lib/email/accounts";
import { getDeepSeekPublicSettings } from "@/lib/deepseek/provider";
import { listResearchRuns } from "@/lib/services/research-runs";
import {
  Card,
  CategoryList,
  EmptyState,
  Notice,
  PageHeader,
  ProgressBar,
  SectionHeading,
} from "@/components/ui";
import { CopyButton } from "@/components/client-ui";
import { JobStatusButton, NewResearchButton } from "@/components/research-actions";
import { ResearchEnginePanel } from "@/components/research-engine";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const params = await searchParams;
  const [jobs, events, accounts, deepseek] = await Promise.all([
    listResearchJobs(),
    getRecentResearchEvents(14),
    listEmailAccounts(),
    getDeepSeekPublicSettings(),
  ]);
  const activeJobs = jobs.filter((job) => job.status !== "archived");
  const totalTarget = activeJobs.reduce((sum, job) => sum + job.targetCount, 0);
  const totalVerified = activeJobs.reduce((sum, job) => sum + job.verifiedCount, 0);
  const totalDrafts = activeJobs.reduce((sum, job) => sum + job.draftCount, 0);
  const primaryJob = activeJobs.find((job) => job.status === "active") ?? activeJobs[0];
  const engineJob =
    activeJobs.find((job) => job.engine === "deepseek" && job.status === "active") ??
    activeJobs.find((job) => job.engine === "deepseek");
  const engineSpend = activeJobs
    .filter((job) => job.engine === "deepseek")
    .reduce((sum, job) => sum + job.spentUsd, 0);
  const recentRuns = engineJob ? await listResearchRuns(engineJob.id, 5) : [];

  const brief = primaryJob
    ? `Research job: ${primaryJob.name}\nJob ID: ${primaryJob.id}\nTarget: ${primaryJob.targetCount} verified commercial trading-signal providers\nAlready verified: ${primaryJob.verifiedCount}\nDrafts saved: ${primaryJob.draftCount}\nRemaining: ${primaryJob.remaining}\nMarkets: ${primaryJob.categories.join(", ")}\nRegions: ${primaryJob.regions}\n\nBefore doing anything, call get_instructions and read_product_truth through Nomeriq Growth. Then continue this exact target from the remaining count. For every candidate, verify paid signals in forex, metals, crypto, indices, or commodities; find an official website and a publicly published business email with its source URL; call check_duplicate against the entire Growth database; then save_prospect and save_draft. Never guess an email, never duplicate an existing business, and never send email.`
    : "";

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Persistent lead discovery"
        title="The search, made repeatable."
        description="Start autonomous DeepSeek discovery that runs on the server without an open browser or chat session. ChatGPT and Claude research the same database, and every verified lead keeps a saved draft."
        actions={
          <>
            {brief && (
              <CopyButton
                value={brief}
                label="Copy assistant brief"
                className="h-10 px-4 text-13"
              />
            )}
            <NewResearchButton defaultOpen={params.new === "1"} />
          </>
        }
      />

      {engineJob ? (
        <section className="mb-4">
          <ResearchEnginePanel job={engineJob} configured={deepseek.configured} />
          {recentRuns.length > 0 && (
            <Card className="mt-3 p-4">
              <SectionHeading
                title="Worker runs"
                description="Each run is a real, bounded worker invocation recorded in the database."
              />
              <div className="mt-3 space-y-1.5">
                {recentRuns.map((run) => (
                  <div
                    key={run.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-paper/50 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          run.status === "running"
                            ? "bg-lime"
                            : run.status === "completed"
                              ? "bg-forest"
                              : "bg-amber"
                        }`}
                      />
                      <span className="font-mono text-12 text-muted">
                        {run.workerId}
                      </span>
                      <span className="text-12 uppercase tracking-[0.1em] text-faint">
                        {run.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-12 text-faint">
                      <span>{run.processed} processed</span>
                      <span>{run.saved} saved</span>
                      {run.errors > 0 && <span className="text-rust">{run.errors} errors</span>}
                      <span>{relativeTime(run.startedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </section>
      ) : (
        <section className="mb-4">
          <Notice
            tone="info"
            title="Autonomous discovery is not running yet."
            action={<NewResearchButton className="btn-secondary btn-sm shrink-0" />}
          >
            Create a DeepSeek research target to let Growth find, verify and save
            qualified trading-signal providers on its own. Nothing is sent to those
            businesses — drafts wait for your review.
            {engineSpend > 0 && ` Recorded DeepSeek spend so far: $${engineSpend.toFixed(4)}.`}
          </Notice>
        </section>
      )}

      {activeJobs.length === 0 ? (
        <Card>
          <EmptyState
            icon="sparkles"
            title="No research target yet"
            description="Start with 25 leads to prove the qualification and email evidence, then scale the same process to 100 and beyond."
            action={<NewResearchButton />}
          />
        </Card>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "Open target", value: totalTarget, icon: Target },
              { label: "Verified", value: totalVerified, icon: UsersRound },
              { label: "Drafts saved", value: totalDrafts, icon: FileText },
              {
                label: "Remaining",
                value: Math.max(0, totalTarget - totalVerified),
                icon: Radar,
              },
            ].map((item) => (
              <Card key={item.label} className="flex items-center gap-4 p-4">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-forest/[0.06] text-forest">
                  <item.icon size={15} />
                </div>
                <div>
                  <div className="text-28 leading-none">{item.value}</div>
                  <div className="mt-1 text-12 font-bold uppercase tracking-[0.12em] text-faint">
                    {item.label}
                  </div>
                </div>
              </Card>
            ))}
          </section>

          <section className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr] [&>*]:min-w-0">
            <div className="space-y-3">
              {jobs.map((job) => (
                <Card key={job.id} className="overflow-hidden">
                  <div className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex h-1.5 w-1.5 rounded-full ${
                              job.status === "active"
                                ? "bg-lime"
                                : job.status === "completed"
                                  ? "bg-forest"
                                  : "bg-amber"
                            }`}
                          />
                          <span className="text-12 font-bold uppercase tracking-[0.15em] text-faint">
                            {job.status}
                          </span>
                          <span className="text-12 text-faint">·</span>
                          <span className="text-12 text-faint">
                            {job.regions}
                          </span>
                          {job.engine === "deepseek" && (
                            <>
                              <span className="text-12 text-faint">·</span>
                              <span className="text-12 font-bold uppercase tracking-[0.12em] text-forest">
                                DeepSeek
                              </span>
                            </>
                          )}
                        </div>
                        <h2 className="mt-2 text-20 font-bold tracking-[-0.02em] text-ink">
                          {job.name}
                        </h2>
                        <div className="mt-2">
                          <CategoryList categories={job.categories} />
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <JobStatusButton job={job} />
                        <Link href={`/leads?job=${job.id}`} className="btn-ghost btn-xs">
                          View leads <ArrowRight size={11} />
                        </Link>
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-5">
                      {(
                        job.engine === "deepseek"
                          ? [
                              ["Target", job.targetCount],
                              ["Verified", job.verifiedCount],
                              ["Candidates", job.candidatesDiscovered],
                              ["Duplicates", job.duplicatesRejected],
                              ["Spend", `$${job.spentUsd.toFixed(4)}`],
                            ]
                          : [
                              ["Target", job.targetCount],
                              ["Verified", job.verifiedCount],
                              ["Emails", job.emailCount],
                              ["Drafts", job.draftCount],
                              ["Duplicates", job.duplicatesRejected],
                            ]
                      ).map(([label, value]) => (
                        <div key={String(label)}>
                          <div className="text-20 font-bold leading-none text-ink">
                            {value}
                          </div>
                          <div className="mt-1 text-12 font-bold uppercase tracking-[0.12em] text-faint">
                            {label}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4">
                      <ProgressBar value={job.verifiedCount} max={job.targetCount} />
                      <div className="mt-2 flex items-center justify-between text-12 text-faint">
                        <span>
                          {job.verifiedCount} of {job.targetCount} counted leads
                        </span>
                        <span>{job.remaining} remaining</span>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 text-12 leading-5 text-muted">
                      {job.requirements}
                    </p>
                  </div>
                </Card>
              ))}
              <Card className="p-5">
                <SectionHeading
                  title="The qualification gate"
                  description="Every counted lead must pass all four tests, not just mention a market."
                />
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
                      Counts
                    </div>
                    <ul className="mt-2 space-y-1.5 text-12 leading-5 text-muted">
                      {[
                        "Genuinely sells signals in Forex, metals, crypto, indices or commodities",
                        "Has an official website",
                        "Publishes a business contact email with an exact source URL",
                        "Shows evidence of paid subscriptions or VIP access",
                      ].map((item) => (
                        <li key={item} className="flex gap-2">
                          <CheckCircle2 size={11} className="mt-1 shrink-0 text-forest" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
                      Never counts
                    </div>
                    <ul className="mt-2 space-y-1.5 text-12 leading-5 text-muted">
                      {[
                        "Brokers, education-only, stocks/options-only",
                        "Indicators, bots, copy-trading only",
                        "News sites or general communities",
                        "Guessed emails or inactive businesses",
                      ].map((item) => (
                        <li key={item} className="flex gap-2">
                          <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-rust" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </Card>
            </div>

            <div className="space-y-4">
              <Card className="p-5">
                <SectionHeading
                  title="How research actually runs"
                  description="No invisible worker, no invented background progress."
                />
                <div className="mt-4 space-y-3">
                  {[
                    {
                      step: "01",
                      title: "Founder creates the target",
                      body: "Target, markets, regions and qualification brief are saved here.",
                    },
                    {
                      step: "02",
                      title: "An assistant researches",
                      body: "ChatGPT or Claude calls the Growth MCP/API from its own session. It verifies the public signal service, email and source.",
                    },
                    {
                      step: "03",
                      title: "Database enforces truth",
                      body: "Duplicate constraints, evidence requirements and progress counts come from PostgreSQL, not chat memory.",
                    },
                    {
                      step: "04",
                      title: "Founder keeps sending",
                      body: "Assistants can save prospects and drafts. They cannot send, delete, change Product Truth or alter permissions.",
                    },
                  ].map((item) => (
                    <div key={item.step} className="flex gap-3">
                      <span className="mt-0.5 text-16 leading-none text-faint">
                        {item.step}
                      </span>
                      <div>
                        <div className="text-12 font-semibold text-ink">
                          {item.title}
                        </div>
                        <p className="mt-0.5 text-12 leading-5 text-muted">
                          {item.body}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-5 rounded-xl border border-line bg-paper/60 p-3">
                  <div className="flex items-center gap-2 text-12 font-bold uppercase tracking-[0.12em] text-faint">
                    <Bot size={12} /> Assistant endpoint
                  </div>
                  <div className="mt-1.5 break-all font-mono text-12 text-muted">
                    {(process.env.APP_URL || "http://localhost:3100") + "/api/mcp"}
                  </div>
                  <Link href="/settings#integrations" className="btn-ghost btn-xs mt-2 -ml-2">
                    Create an API key <ArrowRight size={11} />
                  </Link>
                </div>
              </Card>

              <Card className="p-5">
                <SectionHeading
                  title="Research log"
                  description="The last database events from both assistants."
                />
                <div className="mt-4 space-y-0">
                  {events.length === 0 ? (
                    <p className="text-12 text-muted">No research events yet.</p>
                  ) : (
                    events.map((event, index) => (
                      <div
                        key={event.id}
                        className="relative flex gap-3 pb-4 last:pb-0"
                      >
                        {index < events.length - 1 && (
                          <span className="absolute left-[7px] top-4 h-full w-px bg-line" />
                        )}
                        <span
                          className={`relative z-10 mt-1 grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full border ${
                            event.type === "duplicate_rejected"
                              ? "border-amber/30 bg-amber/10 text-amber"
                              : event.type === "draft_saved"
                                ? "border-forest/20 bg-lime/30 text-forest"
                                : "border-line bg-paper text-muted"
                          }`}
                        >
                          {event.type === "duplicate_rejected" ? (
                            <ShieldCheck size={8} />
                          ) : (
                            <CheckCircle2 size={8} />
                          )}
                        </span>
                        <div className="min-w-0">
                          <div className="text-12 font-medium leading-4 text-ink">
                            {event.type === "verified_saved" && (
                              <>Verified {event.businessName || "prospect"}</>
                            )}
                            {event.type === "draft_saved" && (
                              <>Draft saved{event.businessName ? ` for ${event.businessName}` : ""}</>
                            )}
                            {event.type === "duplicate_rejected" && (
                              <>Duplicate blocked — {event.businessName || "existing lead"}</>
                            )}
                            {!["verified_saved", "draft_saved", "duplicate_rejected"].includes(
                              event.type,
                            ) && event.type.replace(/_/g, " ")}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-12 text-faint">
                            <History size={9} />
                            {relativeTime(event.createdAt)} · {event.actorType}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </Card>
            </div>
          </section>

          <section className="mt-4">
            <Notice
              tone="info"
              title="One shared skill for both assistants."
              action={
                <Link href="/settings#integrations" className="btn-secondary btn-sm shrink-0">
                  Integration setup
                </Link>
              }
            >
              ChatGPT and Claude connect to this same PostgreSQL database through
              an authorized MCP endpoint or REST API. The same instruction
              document is served to both, and neither key has a send permission.
            </Notice>
          </section>
        </>
      )}
    </div>
  );
}
