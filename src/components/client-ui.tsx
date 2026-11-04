"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Copy, LoaderCircle, X } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: "sm" | "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  // Portalled onto <body>, so no ancestor transform, filter or backdrop-filter can turn the
  // fixed positioning into a containing block and push the panel out of the viewport.
  if (!open || !mounted) return null;
  const widths = {
    sm: "max-w-md",
    md: "max-w-2xl",
    lg: "max-w-4xl",
  };
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-forest/35 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // A flex column capped at 90dvh: the header stays put and the body scrolls, so a long
        // form (the key dialog's Name field and assistant choices) is always reachable. The
        // outer layer never scrolls, which is what keeps a second scrollbar from appearing.
        className={cn(
          "flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-[20px] border border-line bg-panel shadow-2xl",
          widths[width],
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line bg-panel px-5 py-4">
          <div>
            <h2 className="text-[16px] font-bold tracking-[-0.01em] text-ink">
              {title}
            </h2>
            {description && (
              <p className="mt-0.5 text-[11.5px] leading-5 text-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost btn-sm -mr-1 shrink-0"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={cn("btn-secondary btn-sm", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const area = document.createElement("textarea");
          area.value = value;
          document.body.appendChild(area);
          area.select();
          document.execCommand("copy");
          area.remove();
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? copiedLabel : label}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      size={14}
      className={cn("spin", className)}
      aria-hidden
    />
  );
}

export function InlineError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <div className="rounded-lg border border-rust/20 bg-rust/[0.05] px-3 py-2 text-[11.5px] leading-5 text-rust">
      {children}
    </div>
  );
}

export async function apiRequest(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<any> {
  const response = await fetch(url, {
    method: options.method || "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload.data;
}

export function SubmitBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
