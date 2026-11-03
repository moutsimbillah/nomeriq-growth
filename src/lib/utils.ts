export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "bad_request",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value.trim());
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

const GENERIC_EMAIL_LOCALS = new Set([
  "info",
  "support",
  "contact",
  "sales",
  "hello",
  "admin",
  "team",
  "office",
  "help",
  "service",
  "services",
  "enquiries",
  "enquiry",
  "marketing",
  "billing",
  "press",
  "careers",
  "jobs",
  "general",
  "mail",
  "inquiries",
]);

/**
 * Generic inboxes can be shared by unrelated businesses and must not, by
 * themselves, merge two prospect records. Website/name/thread identity still
 * deduplicates the same business.
 */
export function isGenericBusinessEmail(email: string): boolean {
  const local = normalizeEmail(email).split("@")[0] ?? "";
  return GENERIC_EMAIL_LOCALS.has(local);
}

export function domainFromUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(
      /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`,
    );
    return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return null;
  }
}

export function normalizeWebsiteUrl(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`,
    );
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

const LEGAL_SUFFIXES = [
  "incorporated",
  "corporation",
  "company",
  "limited",
  "holdings",
  "group",
  "gmbh",
  "sarl",
  "srl",
  "llc",
  "ltd",
  "inc",
  "pte",
  "plc",
  "llp",
  "sa",
  "ag",
  "bv",
  "oy",
  "ab",
  "co",
];

export function normalizeName(value: string): string {
  let key = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (key.endsWith(` ${suffix}`) && key.length > suffix.length + 2) {
        key = key.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return key;
}

export function normalizeHandle(
  value: string | null | undefined,
  platform?: "instagram" | "youtube" | "x" | "telegram",
): string | null {
  if (!value?.trim()) return null;
  let raw = value.trim();
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      const segments = url.pathname.split("/").filter(Boolean);
      if (platform === "youtube") {
        const channel = segments.find((segment) => segment.startsWith("channel/"));
        if (channel) return channel.replace(/^channel\//, "").toLowerCase();
        const at = segments.find((segment) => segment.startsWith("@"));
        if (at) return at.slice(1).toLowerCase();
      }
      const last = segments.at(-1) ?? "";
      raw = last.replace(/^@/, "").replace(/^~/, "");
    }
  } catch {
    // Treat malformed URLs as handles so deduplication fails closed, not open.
    raw = raw.split("/").filter(Boolean).at(-1) ?? raw;
  }
  return raw
    .replace(/^@/, "")
    .replace(/^https?:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .trim()
    .toLowerCase() || null;
}

export function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, "");
}

export function iso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function formatDate(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  if (!value) return "Unknown";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-GB", {
    ...options,
    timeZone: process.env.APP_TIMEZONE || "Asia/Karachi",
  }).format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  return formatDate(value, { dateStyle: "medium", timeStyle: "short" });
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 604_800_000) return rtf.format(Math.round(diff / 86_400_000), "day");
  if (abs < 2_592_000_000) return rtf.format(Math.round(diff / 604_800_000), "week");
  return rtf.format(Math.round(diff / 2_592_000_000), "month");
}

export function wordCount(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

export function truncate(value: string, length = 160): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= length) return clean;
  return `${clean.slice(0, length - 1).trimEnd()}…`;
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

export function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export function number(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function textToHtmlParagraphs(value: string): string {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function splitList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function slugify(value: string): string {
  return normalizeName(value).replace(/\s+/g, "-").slice(0, 60);
}
