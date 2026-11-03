import { LogoMark } from "@/components/logo";
import { UnsubscribeForm } from "@/components/unsubscribe-form";

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[500px]">
        <div className="mb-10 flex items-center gap-2.5">
          <LogoMark />
          <div>
            <div className="text-[12px] font-bold tracking-[0.15em] text-ink">
              NOMERIQ
            </div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.22em] text-muted">
              Growth
            </div>
          </div>
        </div>
        <div className="card p-6 sm:p-8">
          <UnsubscribeForm token={token} />
        </div>
      </div>
    </main>
  );
}
