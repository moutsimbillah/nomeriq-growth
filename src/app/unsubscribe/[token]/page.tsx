import { LogoMark } from "@/components/logo";
import { UnsubscribeForm } from "@/components/unsubscribe-form";
import { inspectUnsubscribeToken } from "@/lib/services/suppressions";

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const link = await inspectUnsubscribeToken(token);
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[500px]">
        <div className="mb-10 flex items-center gap-2.5">
          <LogoMark />
          <div>
            <div className="text-12 font-bold tracking-[0.15em] text-ink">
              NOMERIQ
            </div>
            <div className="text-12 font-semibold uppercase tracking-[0.22em] text-muted">
              Growth
            </div>
          </div>
        </div>
        <div className="card p-6 sm:p-8">
          {link.status === "valid" ? (
            <UnsubscribeForm token={token} />
          ) : link.status === "already_unsubscribed" ? (
            <div>
              <div className="eyebrow mb-3">Email preference</div>
              <h1 className="display-title text-display">
                This address is already unsubscribed.
              </h1>
              <p className="mt-4 text-13 leading-6 text-muted">
                This address is already on the Nomeriq Growth suppression list, so no
                further promotional email will be sent to it. You do not need to do
                anything else.
              </p>
            </div>
          ) : (
            <div>
              <div className="eyebrow mb-3">Email preference</div>
              <h1 className="display-title text-display">This link is not valid.</h1>
              <p className="mt-4 text-13 leading-6 text-muted">
                This unsubscribe link is incomplete, or it was not one we issued. Links
                are unique to each message, so they can break if an email program cuts
                the line. If you want to stop receiving email, reply to any message
                from us and we will remove this address by hand.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
