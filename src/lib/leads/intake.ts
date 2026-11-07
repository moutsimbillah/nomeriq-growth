import { z } from "zod";
import { assessmentSchema, audienceSchema, routeSchema } from "@/lib/leads/model";

// These fields are server provenance, never caller-granted founder authority or imported history.
const { sourceKind, sourceReference, sourceAgent, aiProvider, aiModel, legacySnapshot, provenanceKey, ...assessmentFields } = assessmentSchema.shape;
void sourceKind; void sourceReference; void sourceAgent; void aiProvider; void aiModel; void legacySnapshot; void provenanceKey;
const { provenanceKey: audienceProvenance, ...audienceFields } = audienceSchema.shape;
const { provenanceKey: routeProvenance, ...routeFields } = routeSchema.shape;
void audienceProvenance; void routeProvenance;

export const intakeAssessmentSchema = z.object(assessmentFields).strict().refine(
  a => a.eligibility !== "excluded" || Boolean(a.exclusionReason?.trim()),
  "Exclusion requires a reason.",
);
export const intakeAudienceSchema = z.object(audienceFields).strict().refine(
  a => a.countState === "verified" ? a.countValue !== null : a.countValue === null,
  "Unknown and zero are different; verified counts need a number.",
);
export const intakeContactRouteSchema = z.object(routeFields).strict().refine(
  r => Boolean(r.handle?.trim() || r.routeUrl), "A route needs a handle or URL.",
);
export const leadIntakeSchema = z.object({
  leadAssessment: intakeAssessmentSchema.optional(),
  audiences: z.array(intakeAudienceSchema).max(100).default([]),
  contactRoutes: z.array(intakeContactRouteSchema).max(100).default([]),
}).strict().refine(
  value => Boolean(value.leadAssessment) || !value.audiences.length && !value.contactRoutes.length,
  "New audience/contact evidence must be saved with its qualification assessment.",
);
export type LeadIntake = z.input<typeof leadIntakeSchema>;
