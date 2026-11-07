import { requirePageUser } from "@/lib/auth/session";
import { getMailboxSidebarState } from "@/lib/email/accounts";
import { getProductTruth, getWorkspaceSettings } from "@/lib/services/settings";
import { AppChrome } from "@/components/app-chrome";
import { WorkspaceTimezoneProvider } from "@/components/workspace-timezone";

export const dynamic = "force-dynamic";

export default async function GrowthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageUser();
  const [settings, mailbox, truth] = await Promise.all([
    getWorkspaceSettings(),
    getMailboxSidebarState().catch(() => ({ kind: "none" as const, label: null })),
    getProductTruth(),
  ]);
  const sendMode =
    (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase() === "live"
      ? "live"
      : "sandbox";

  return (
    <WorkspaceTimezoneProvider timezone={settings.timezone}>
      <AppChrome
        user={{ name: user.name, email: user.email, role: user.role }}
        sendMode={sendMode}
        mailboxLabel={mailbox.label}
        productTruthReady={truth.status === "approved"}
      >
        {children}
      </AppChrome>
    </WorkspaceTimezoneProvider>
  );
}
