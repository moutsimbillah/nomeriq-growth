/**
 * Product Truth JSON export/import — browser-safe (no server imports), shared by the Product Truth
 * form and the PUT /api/product-truth route.
 *
 * Export writes the saved record exactly as Growth reads it back (`ProductTruth` from
 * getProductTruth: id, version, status, the nine content fields, approvedAt, updatedAt).
 * Import accepts that same shape, validates it, and returns ONLY the nine editable content fields.
 * The file's id/version/status/approvedAt/updatedAt are checked for correct types and reported, but
 * never applied: importing loads the form; only the founder's explicit Save draft / Save & approve
 * persists anything, and approval always comes from that click, never from the file.
 */
import { z } from "zod";
import type { ProductTruth } from "@/lib/types";

/** The current PUT limits. The route's schema is built from these, so import cannot drift. */
export const PRODUCT_TRUTH_LIMITS = {
  oneLiner: 500,
  approvedClaims: { items: 100, chars: 1000 },
  prohibitedClaims: { items: 100, chars: 500 },
  discoveryQuestions: { items: 50, chars: 1000 },
} as const;

/** Largest import file accepted (bytes); independent of individual paragraph lengths. */
export const PRODUCT_TRUTH_IMPORT_MAX_BYTES = 1_048_576;

export const PRODUCT_TRUTH_TEXT_FIELDS = [
  "oneLiner",
  "offerSummary",
  "howItWorks",
  "pricingNotes",
  "integrations",
  "limitations",
] as const;
export const PRODUCT_TRUTH_LIST_FIELDS = [
  "approvedClaims",
  "prohibitedClaims",
  "discoveryQuestions",
] as const;
export const PRODUCT_TRUTH_CONTENT_FIELDS = [
  ...PRODUCT_TRUTH_TEXT_FIELDS,
  ...PRODUCT_TRUTH_LIST_FIELDS,
] as const;
/** Saved-record metadata: validated on import, never applied. */
export const PRODUCT_TRUTH_METADATA_FIELDS = [
  "id",
  "version",
  "status",
  "approvedAt",
  "updatedAt",
] as const;

export type ProductTruthContentField = (typeof PRODUCT_TRUTH_CONTENT_FIELDS)[number];
export type ProductTruthListField = (typeof PRODUCT_TRUTH_LIST_FIELDS)[number];
export type ProductTruthContent = Pick<ProductTruth, ProductTruthContentField>;
/** Form state: lists are edited one entry per line. */
export type ProductTruthFormState = Record<ProductTruthContentField, string>;

export const PRODUCT_TRUTH_FIELD_LABELS: Record<ProductTruthContentField, string> = {
  oneLiner: "One-line description",
  offerSummary: "What Nomeriq offers",
  howItWorks: "How it works",
  pricingNotes: "Approved pricing and commercial terms",
  integrations: "Approved integrations",
  limitations: "Limitations and things not to claim",
  approvedClaims: "Approved claims",
  prohibitedClaims: "Prohibited claims",
  discoveryQuestions: "Questions to ask prospects",
};

const L = PRODUCT_TRUTH_LIMITS;

/** The nine content fields with the exact PUT limits (discovery questions required here). */
export const productTruthContentShape = {
  oneLiner: z.string().min(1).max(L.oneLiner),
  // Founder-maintained paragraphs have no per-field character cap. File uploads remain size-bounded.
  offerSummary: z.string(),
  howItWorks: z.string(),
  pricingNotes: z.string(),
  integrations: z.string(),
  limitations: z.string(),
  approvedClaims: z.array(z.string().max(L.approvedClaims.chars)).max(L.approvedClaims.items),
  prohibitedClaims: z.array(z.string().max(L.prohibitedClaims.chars)).max(L.prohibitedClaims.items),
  discoveryQuestions: z
    .array(z.string().max(L.discoveryQuestions.chars))
    .max(L.discoveryQuestions.items),
};

/** PUT /api/product-truth body — unchanged behaviour: questions optional, unknown keys stripped. */
export const productTruthSaveSchema = z.object({
  ...productTruthContentShape,
  discoveryQuestions: productTruthContentShape.discoveryQuestions.optional(),
  approve: z.boolean(),
});

/** Exactly the saved/read ProductTruth, in the mapper's key order. */
export function productTruthExportObject(truth: ProductTruth): ProductTruth {
  return {
    id: truth.id,
    version: truth.version,
    status: truth.status,
    oneLiner: truth.oneLiner,
    offerSummary: truth.offerSummary,
    howItWorks: truth.howItWorks,
    pricingNotes: truth.pricingNotes,
    integrations: truth.integrations,
    limitations: truth.limitations,
    approvedClaims: [...truth.approvedClaims],
    prohibitedClaims: [...truth.prohibitedClaims],
    discoveryQuestions: [...(truth.discoveryQuestions ?? [])],
    approvedAt: truth.approvedAt,
    updatedAt: truth.updatedAt,
  };
}

export function productTruthExportJson(truth: ProductTruth): string {
  return `${JSON.stringify(productTruthExportObject(truth), null, 2)}\n`;
}

export function productTruthExportFileName(truth: ProductTruth): string {
  const status = truth.status === "approved" ? "approved" : "draft";
  return `nomeriq-product-truth-v${truth.version}-${status}.json`;
}

export interface ProductTruthImportMetadata {
  id?: string;
  version?: number;
  status?: ProductTruth["status"];
  approvedAt?: string | null;
  updatedAt?: string;
}

export type ProductTruthImportResult =
  | { ok: true; content: ProductTruthContent; metadata: ProductTruthImportMetadata }
  | { ok: false; errors: string[] };

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function label(field: string) {
  return (PRODUCT_TRUTH_FIELD_LABELS as Record<string, string>)[field] ?? field;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const [field, index] = issue.path;
  const where =
    typeof index === "number"
      ? `${label(String(field))} (${String(field)}) entry ${index + 1}`
      : `${label(String(field))} (${String(field)})`;
  if (issue.code === "too_big") {
    const max = Number(issue.maximum);
    return issue.origin === "array"
      ? `${where} has more than ${max} entries.`
      : `${where} is longer than ${max} characters.`;
  }
  if (issue.code === "too_small") return `${where} must not be empty.`;
  if (issue.code === "invalid_type") {
    return `${where} must be ${issue.expected === "array" ? "a list of text entries" : `a ${issue.expected}`}.`;
  }
  return `${where}: ${issue.message}`;
}

/**
 * Validate an import file's text. Never mutates anything and never sends a request. Errors are
 * complete (every problem found) and name the field, so the founder can fix the file and retry.
 */
export function parseProductTruthImport(text: string): ProductTruthImportResult {
  if (new TextEncoder().encode(text).length > PRODUCT_TRUTH_IMPORT_MAX_BYTES) {
    return {
      ok: false,
      errors: [`The file is larger than ${Math.round(PRODUCT_TRUTH_IMPORT_MAX_BYTES / 1024)} KB.`],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, errors: ["The file is not valid JSON."] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: ["The file must contain one Product Truth object, as written by Export."],
    };
  }
  const record = raw as Record<string, unknown>;
  const errors: string[] = [];

  const known = new Set<string>([...PRODUCT_TRUTH_CONTENT_FIELDS, ...PRODUCT_TRUTH_METADATA_FIELDS]);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length) {
    errors.push(`Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`);
  }
  const missing = PRODUCT_TRUTH_CONTENT_FIELDS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (missing.length) {
    errors.push(`Missing field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
  }

  // Metadata: optional, checked for the saved record's types, never applied.
  const metadata: ProductTruthImportMetadata = {};
  if ("id" in record) {
    if (typeof record.id === "string" && record.id.trim() && record.id.length <= 200) metadata.id = record.id;
    else errors.push("id must be a non-empty text value.");
  }
  if ("version" in record) {
    if (typeof record.version === "number" && Number.isSafeInteger(record.version) && record.version >= 1) {
      metadata.version = record.version;
    } else errors.push("version must be a whole number of 1 or more.");
  }
  if ("status" in record) {
    if (record.status === "approved" || record.status === "needs_review") metadata.status = record.status;
    else errors.push('status must be "approved" or "needs_review".');
  }
  if ("approvedAt" in record) {
    if (record.approvedAt === null || (typeof record.approvedAt === "string" && isIsoDate(record.approvedAt))) {
      metadata.approvedAt = record.approvedAt as string | null;
    } else errors.push("approvedAt must be null or an ISO date-time.");
  }
  if ("updatedAt" in record) {
    if (typeof record.updatedAt === "string" && isIsoDate(record.updatedAt)) metadata.updatedAt = record.updatedAt;
    else errors.push("updatedAt must be an ISO date-time.");
  }

  // Content: only the nine editable fields, with the same limits Save enforces.
  const content: Record<string, unknown> = {};
  for (const key of PRODUCT_TRUTH_CONTENT_FIELDS) if (key in record) content[key] = record[key];
  const parsed = z.object(productTruthContentShape).partial().safeParse(content);
  if (!parsed.success) errors.push(...parsed.error.issues.map(describeIssue));
  else {
    if (typeof parsed.data.oneLiner === "string" && !parsed.data.oneLiner.trim()) {
      errors.push(`${label("oneLiner")} (oneLiner) must not be empty.`);
    }
    // The form edits lists one entry per line, and Save drops blank entries. A line break inside an
    // entry or a blank entry would therefore be split or silently lost — refuse it instead.
    for (const key of PRODUCT_TRUTH_LIST_FIELDS) {
      (parsed.data[key] ?? []).forEach((entry, index) => {
        if (/[\r\n]/.test(entry)) {
          errors.push(
            `${label(key)} (${key}) entry ${index + 1} contains a line break; each entry must be a single line.`,
          );
        } else if (!entry.trim()) {
          errors.push(`${label(key)} (${key}) entry ${index + 1} is empty.`);
        }
      });
    }
  }

  if (errors.length) return { ok: false, errors };
  const data = parsed.success ? parsed.data : {};
  return {
    ok: true,
    content: {
      oneLiner: data.oneLiner!,
      offerSummary: data.offerSummary!,
      howItWorks: data.howItWorks!,
      pricingNotes: data.pricingNotes!,
      integrations: data.integrations!,
      limitations: data.limitations!,
      approvedClaims: [...data.approvedClaims!],
      prohibitedClaims: [...data.prohibitedClaims!],
      discoveryQuestions: [...data.discoveryQuestions!],
    },
    metadata,
  };
}

/** Form lists are one entry per line. */
export function listToFormLines(values: readonly string[] | undefined): string {
  return (values ?? []).join("\n");
}

/** The form's existing list parsing: split on lines, trim, drop blanks. */
export function formLinesToList(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function productTruthToFormState(content: ProductTruthContent): ProductTruthFormState {
  return {
    oneLiner: content.oneLiner,
    offerSummary: content.offerSummary,
    howItWorks: content.howItWorks,
    pricingNotes: content.pricingNotes,
    integrations: content.integrations,
    limitations: content.limitations,
    approvedClaims: listToFormLines(content.approvedClaims),
    prohibitedClaims: listToFormLines(content.prohibitedClaims),
    discoveryQuestions: listToFormLines(content.discoveryQuestions),
  };
}

/** PUT body from the form. `approve` comes only from the button the founder clicked. */
export function productTruthSaveBody(form: ProductTruthFormState, approve: boolean) {
  return {
    oneLiner: form.oneLiner,
    offerSummary: form.offerSummary,
    howItWorks: form.howItWorks,
    pricingNotes: form.pricingNotes,
    integrations: form.integrations,
    limitations: form.limitations,
    approvedClaims: formLinesToList(form.approvedClaims),
    prohibitedClaims: formLinesToList(form.prohibitedClaims),
    discoveryQuestions: formLinesToList(form.discoveryQuestions),
    approve,
  };
}

/** The form as Save would store it (text trimmed, lists split/trimmed/blank-free), for dirty checks. */
export function savedFormOf(form: ProductTruthFormState): ProductTruthFormState {
  const body = productTruthSaveBody(form, false);
  return productTruthToFormState({
    oneLiner: body.oneLiner.trim(),
    offerSummary: body.offerSummary.trim(),
    howItWorks: body.howItWorks.trim(),
    pricingNotes: body.pricingNotes.trim(),
    integrations: body.integrations.trim(),
    limitations: body.limitations.trim(),
    approvedClaims: body.approvedClaims,
    prohibitedClaims: body.prohibitedClaims,
    discoveryQuestions: body.discoveryQuestions,
  });
}

/** Content fields whose form value differs between two states. */
export function changedProductTruthFields(
  a: ProductTruthFormState,
  b: ProductTruthFormState,
): ProductTruthContentField[] {
  return PRODUCT_TRUTH_CONTENT_FIELDS.filter((key) => a[key] !== b[key]);
}
