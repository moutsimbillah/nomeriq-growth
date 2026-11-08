import { getWorkspaceSettings } from "@/lib/services/settings";
import { resolveSendingProfile } from "@/lib/email/profiles";
import type { EmailIdentitySettings } from "@/lib/email/message-content";

export interface EmailPresentation {
  settings: EmailIdentitySettings;
  profileSignature: string;
}

/** Explicit allowlist: never serialize an account record or its encrypted credentials to the UI. */
export async function getEmailPresentation(input: { prospectId: string; conversationId?: string | null }): Promise<EmailPresentation> {
  const [settings, profile] = await Promise.all([getWorkspaceSettings(), resolveSendingProfile(input)]);
  return {
    settings: {
      senderSignature: settings.senderSignature, senderSignatureEnabled: settings.senderSignatureEnabled,
      postalAddress: settings.postalAddress, postalAddressEnabled: settings.postalAddressEnabled,
      legalBusinessName: settings.legalBusinessName, footerNote: settings.footerNote,
    },
    profileSignature: profile?.signature ?? "",
  };
}
