import {
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  History,
  ShieldAlert,
} from "lucide-react";
import {
  getProductTruth,
  getWorkspaceSettings,
  listProductTruthRevisions,
} from "@/lib/services/settings";
import {
  Card,
  PageHeader,
  SectionHeading,
} from "@/components/ui";
import { ProductTruthForm } from "@/components/product-truth-form";
import { productTruthGaps } from "@/lib/ai/product-truth";
import { formatDateTime, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ProductTruthPage() {
  const [truth, revisions] = await Promise.all([
    getProductTruth(),
    listProductTruthRevisions(),
  ]);
  const { timezone } = await getWorkspaceSettings();
  const gaps = productTruthGaps(truth);

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Founder-controlled source of truth"
        title="The facts AI is allowed to use."
        description="One controlled record of what Nomeriq does, what it costs, what it integrates with and what it must never claim. AI drafts are checked against it; your own reviewed emails are not turned into an approval ritual."
        actions={
          <span
            className={`badge ${
              truth.status === "approved"
                ? "border-forest/20 bg-lime/25 text-forest"
                : "border-amber/20 bg-amber/[0.07] text-amber"
            }`}
          >
            {truth.status === "approved" ? (
              <>
                <CheckCircle2 size={10} /> Approved v{truth.version}
              </>
            ) : (
              "Needs approval"
            )}
          </span>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <ProductTruthForm truth={truth} />

        <div className="space-y-4">
          <div data-product-truth-gaps>
          <Card className="p-5">
            <SectionHeading
              title={gaps.length ? "What's missing" : "Complete"}
              description={
                gaps.length
                  ? `Version ${truth.version} · ${truth.status === "approved" ? "approved" : "not approved"}. Every AI action receives this record in full; these gaps limit what it may say.`
                  : `Version ${truth.version} is approved and every section has content.`
              }
              action={<ShieldAlert size={13} className={gaps.length ? "text-amber" : "text-faint"} />}
            />
            {gaps.length > 0 && (
              <ul className="mt-3 space-y-2 text-12 leading-5">
                {gaps.map((gap) => (
                  <li key={gap.field} className="rounded-lg border border-amber/20 bg-amber/[0.05] px-3 py-2">
                    <span className="font-semibold text-ink">{gap.field}</span>
                    <span className="text-muted"> — {gap.problem}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          </div>

          <Card className="p-5">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-lime/30 text-forest">
              <BookOpenCheck size={16} />
            </div>
            <SectionHeading
              className="mt-4"
              title="How this is used"
              description="Knowledge, not a second approval chain."
            />
            <div className="mt-4 space-y-3 text-12 leading-5 text-muted">
              <p>
                <strong className="text-ink">AI first-contact drafts</strong> are
                generated only from approved claims, then checked for pricing,
                feature and performance claims. Warnings appear before the
                founder approves.
              </p>
              <p>
                <strong className="text-ink">AI reply suggestions</strong> answer
                the actual thread. If the answer is not in Product Truth, the AI
                is instructed to flag it rather than invent it.
              </p>
              <p>
                <strong className="text-ink">Founder-written replies</strong> can
                be sent after a normal review. There are no claim-reference
                checkboxes, repetitive disclosures or extra internal approval
                steps. Legal, opt-out and delivery safeguards still run.
              </p>
            </div>
          </Card>

          <Card className="p-5">
            <SectionHeading
              title="Version history"
              description="Every save is retained as an audit snapshot."
              action={<History size={13} className="text-faint" />}
            />
            <div className="mt-4 space-y-0">
              {revisions.length === 0 ? (
                <p className="text-12 text-muted">
                  No revisions yet. The current seed version is the first record.
                </p>
              ) : (
                revisions.slice(0, 8).map((revision, index) => (
                  <div key={revision.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {index < Math.min(revisions.length, 8) - 1 && (
                      <span className="absolute left-[6px] top-4 h-full w-px bg-line" />
                    )}
                    <span
                      className={`relative z-10 mt-1.5 h-[13px] w-[13px] shrink-0 rounded-full border ${
                        revision.status === "approved"
                          ? "border-forest/20 bg-lime/40"
                          : "border-line bg-paper"
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="text-12 font-semibold text-ink">
                        Version {revision.version}
                        <span className="ml-1.5 font-normal text-faint">
                          {revision.status === "approved" ? "approved" : "draft"}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-12 text-faint">
                        <Clock3 size={8} />
                        {relativeTime(revision.createdAt)}
                        {revision.authorName ? ` · ${revision.authorName}` : ""}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          {truth.status !== "approved" && (
            <div className="rounded-[18px] border border-amber/25 bg-amber/[0.06] p-5">
              <div className="flex items-center gap-2 text-12 font-bold uppercase tracking-[0.12em] text-amber">
                <ShieldAlert size={12} /> Approval required
              </div>
              <p className="mt-2 text-12 leading-5 text-[#76501a]">
                Until this is approved, Growth intentionally restricts AI to the
                single factual platform description. That protects outreach from
                invented features, pricing or outcomes.
              </p>
            </div>
          )}

          {truth.approvedAt && (
            <div className="px-1 text-12 text-faint">
              Last approved {formatDateTime(truth.approvedAt, timezone)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
