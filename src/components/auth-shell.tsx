import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { LogoMark } from "./logo";

export function AuthShell({
  children,
  title,
  description,
  eyebrow,
  mode,
}: {
  children: ReactNode;
  title: string;
  description: string;
  eyebrow: string;
  mode: "login" | "setup";
}) {
  return (
    <main className="grid min-h-screen lg:grid-cols-[1.08fr_0.92fr]">
      <section className="relative hidden overflow-hidden bg-forest p-10 text-white lg:flex lg:flex-col xl:p-14">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(800px_500px_at_18%_0%,rgba(201,243,109,0.14),transparent_65%)]" />
        <div className="pointer-events-none absolute -bottom-48 -right-36 h-[560px] w-[560px] rounded-full border border-white/[0.06]" />
        <div className="pointer-events-none absolute -bottom-28 -right-16 h-[360px] w-[360px] rounded-full border border-white/[0.07]" />
        <div className="relative z-10 flex items-center gap-3">
          <LogoMark className="h-10 w-10" />
          <div>
            <div className="text-[13px] font-bold tracking-[0.16em]">NOMERIQ</div>
            <div className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.28em] text-white/35">
              Growth
            </div>
          </div>
        </div>

        <div className="relative z-10 my-auto max-w-xl py-16">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-lime">
            <span className="h-1.5 w-1.5 rounded-full bg-lime" />
            Independent sales workspace
          </div>
          <h1 className="display-title text-[64px] leading-[0.94] text-white xl:text-[76px]">
            The work between
            <br />
            <em className="text-lime">signal</em> and sale.
          </h1>
          <p className="mt-6 max-w-md text-[13px] leading-6 text-white/52">
            Find commercial trading-signal providers, verify their public emails,
            personalize every first conversation, and manage the replies — without
            duplicating a single lead.
          </p>

          <div className="mt-10 grid max-w-md grid-cols-1 gap-2.5">
            {[
              "Verified leads, not scraped lists",
              "Public-source emails with evidence",
              "AI drafts the founder actually controls",
              "Replies and follow-ups in one thread",
            ].map((item) => (
              <div
                key={item}
                className="flex items-center gap-3 border-b border-white/[0.07] pb-2.5 text-[12px] text-white/62 last:border-0"
              >
                <span className="grid h-5 w-5 place-items-center rounded-full bg-lime/15 text-lime">
                  <Check size={11} strokeWidth={2.6} />
                </span>
                {item}
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10 flex items-center justify-between text-[9.5px] uppercase tracking-[0.15em] text-white/24">
          <span>Nomeriq Growth</span>
          <span>Separate infrastructure</span>
        </div>
      </section>

      <section className="relative flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-[410px]">
          <div className="mb-10 flex items-center justify-between lg:hidden">
            <div className="flex items-center gap-2.5 text-ink">
              <LogoMark />
              <span className="text-[12px] font-bold tracking-[0.15em]">NOMERIQ</span>
              <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-muted">
                Growth
              </span>
            </div>
          </div>
          <div className="eyebrow mb-3">{eyebrow}</div>
          <h2 className="display-title text-[46px]">{title}</h2>
          <p className="mt-3 text-[13px] leading-6 text-muted">{description}</p>
          <div className="mt-8">{children}</div>
          <div className="mt-10 flex items-center gap-2 border-t border-line pt-4 text-[9.5px] uppercase tracking-[0.12em] text-faint">
            <span>Growth is independent of the Nomeriq product</span>
            {mode === "setup" && <span className="ml-auto">One-time setup</span>}
          </div>
          {mode === "login" && (
            <p className="mt-5 text-[10.5px] text-faint">
              Access is limited to founder-approved Growth users. Ask the
              workspace owner if you need an account.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
