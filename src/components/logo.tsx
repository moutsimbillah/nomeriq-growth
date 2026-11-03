import { cn } from "@/lib/cn";

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[11px] bg-lime text-forest",
        className,
      )}
      aria-hidden
    >
      <span className="font-display text-[23px] leading-none -translate-y-[1px]">
        N
      </span>
      <span className="absolute bottom-[5px] right-[5px] h-1 w-1 rounded-full bg-forest/70" />
    </span>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark />
      <div className="leading-none">
        <div className="text-[13px] font-bold tracking-[0.14em] text-white">
          NOMERIQ
        </div>
        {!compact && (
          <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.25em] text-white/42">
            Growth
          </div>
        )}
      </div>
    </div>
  );
}
