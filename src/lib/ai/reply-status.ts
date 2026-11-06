export const NO_AI_TEMPLATE_LABEL = "Standard template — no AI provider connected";
export const FAILED_AI_TEMPLATE_LABEL = "AI provider failed — standard template";

/** Keep intentional signatures; replace only the legacy role-placeholder with the sender identity. */
export function suggestionSignature(profileSignature: string | null | undefined, workspaceSignature: string, fromName?: string | null): string {
  if (profileSignature?.trim()) return profileSignature.trim();
  const workspace = workspaceSignature.trim();
  if (workspace && !/^Founder(?:\r?\nNomeriq)?$/i.test(workspace)) return workspace;
  const identity = fromName?.trim();
  if (identity && !/^Founder$/i.test(identity)) return identity.replace(/\s+·\s+/, "\n");
  // Never invent a personal name when no sender identity is configured.
  return "Nomeriq";
}
