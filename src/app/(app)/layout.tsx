import { requirePageUser } from "@/lib/auth/session";
import { getDefaultEmailAccount } from "@/lib/email/accounts";
import { getProductTruth, getWorkspaceSettings } from "@/lib/services/settings";
import { AppChrome } from "@/components/app-chrome";

export const dynamic = "force-dynamic";

export default async function GrowthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageUser();
  const [settings, account, truth] = await Promise.all([
    getWorkspaceSettings(),
    getDefaultEmailAccount().catch(() => null),
    getProductTruth(),
  ]);
  const sendMode =
    (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase() === "live"
      ? "live"
      : "sandbox";

  return (
    <AppChrome
      user={{ name: user.name, email: user.email, role: user.role }}
      sendMode={sendMode}
      mailboxLabel={
        account
          ? `${account.emailAddress}${account.provider === "sandbox" ? " · sandbox" : ""}`
          : null
      }
      productTruthReady={truth.status === "approved"}
    >
      {children}
    </AppChrome>
  );
}
