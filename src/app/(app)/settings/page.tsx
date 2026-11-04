import Link from "next/link";
import type { ReactNode } from "react";
import {
  BookOpenCheck,
  Bot,
  Database,
  KeyRound,
  Mail,
  PenLine,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
} from "lucide-react";
import {
  getWorkspaceSettings,
  listUsers,
} from "@/lib/services/settings";
import { listEmailAccounts } from "@/lib/email/accounts";
import { getSyncHealth } from "@/lib/email/sync";
import { getSendUsage } from "@/lib/services/email-sending";
import { listApiKeys } from "@/lib/agent/apiKeys";
import { listSuppressions } from "@/lib/services/suppressions";
import { getDeepSeekPublicSettings } from "@/lib/deepseek/provider";
import { listResearchProviders } from "@/lib/deepseek/provider-pool";
import { Card, PageHeader, SectionHeading } from "@/components/ui";
import { WorkspaceSettingsForm } from "@/components/settings/workspace-form";
import { EmailAccountsManager } from "@/components/settings/email-accounts";
import { IntegrationsManager } from "@/components/settings/integrations";
import { DeepSeekSettings } from "@/components/settings/deepseek";
import { ProvidersCard } from "@/components/settings/providers";
import {
  BackupPanel,
  SuppressionManager,
  TeamManager,
} from "@/components/settings/admin";

export const dynamic = "force-dynamic";

function SettingsSection({
  id,
  icon: Icon,
  eyebrow,
  title,
  description,
  children,
}: {
  id: string;
  icon: typeof Mail;
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-forest/[0.055] text-forest">
              <Icon size={15} />
            </div>
            <div>
              <div className="text-12 font-bold uppercase tracking-[0.14em] text-faint">
                {eyebrow}
              </div>
              <h2 className="mt-0.5 text-16 font-bold tracking-[-0.01em] text-ink">
                {title}
              </h2>
              {description && (
                <p className="mt-1 max-w-2xl text-12 leading-5 text-muted">
                  {description}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="p-5">{children}</div>
      </Card>
    </section>
  );
}

export default async function SettingsPage() {
  const [settings, accounts, apiKeys, users, suppressions, deepseekSettings, researchProviders] =
    await Promise.all([
      getWorkspaceSettings(),
      listEmailAccounts(),
      listApiKeys(),
      listUsers(),
      listSuppressions(),
      getDeepSeekPublicSettings(),
      listResearchProviders(),
    ]);
  const usages: Record<string, Awaited<ReturnType<typeof getSendUsage>>> = {};
  const health: Record<
    string,
    Awaited<ReturnType<typeof getSyncHealth>>
  > = {};
  for (const account of accounts) {
    usages[account.id] = await getSendUsage(account.id).catch(() => ({
      sentLast24h: 0,
      dailyLimit: account.dailySendLimit,
      minIntervalSeconds: account.minIntervalSeconds,
      nextAllowedAt: null,
    }));
    health[account.id] =
      account.provider === "sandbox"
        ? []
        : await getSyncHealth(account.id).catch(() => []);
  }
  const appUrl = (process.env.APP_URL || "http://localhost:3100").replace(/\/$/, "");
  const sendMode =
    (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase() === "live"
      ? "live"
      : "sandbox";
  const aiProvider = (process.env.AI_PROVIDER || "none").toLowerCase();

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Workspace configuration"
        title="The controls that matter."
        description="One mailbox, one set of legal terms, one assistant boundary. No extra infrastructure unless the workflow truly needs it."
        actions={
          <Link href="/dashboard" className="btn-ghost">
            Back to dashboard
          </Link>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[190px_1fr] [&>*]:min-w-0">
        <aside className="hidden xl:block">
          <nav className="sticky top-6 space-y-0.5">
            {[
              ["outreach", "Sending identity", PenLine],
              ["email", "Email accounts", Mail],
              ["deepseek", "DeepSeek engine", Sparkles],
              ["integrations", "AI integrations", Bot],
              ["team", "Users", UsersRound],
              ["privacy", "Privacy & data", ShieldCheck],
              ["system", "System", SlidersHorizontal],
            ].map(([href, label, Icon]) => {
              const NavIcon = Icon as typeof Mail;
              return (
                <a
                  key={href as string}
                  href={`#${href}`}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-12 font-medium text-muted transition hover:bg-ink/[0.03] hover:text-ink"
                >
                  <NavIcon size={13} />
                  {label as string}
                </a>
              );
            })}
            <div className="mt-4 border-t border-line pt-3">
              <a
                href="/api/assistant-skill"
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-12 font-medium text-muted transition hover:bg-ink/[0.03] hover:text-ink"
              >
                <BookOpenCheck size={13} />
                Assistant skill
              </a>
            </div>
          </nav>
        </aside>

        <div className="space-y-4">
          <SettingsSection
            id="outreach"
            icon={PenLine}
            eyebrow="Founder identity"
            title="Sending identity and follow-up rules"
            description="These values are appended to outbound mail and enforced server-side. The founder remains in control of every send."
          >
            <WorkspaceSettingsForm settings={settings} appUrl={appUrl} />
          </SettingsSection>

          <SettingsSection
            id="email"
            icon={Mail}
            eyebrow="SMTP + IMAP"
            title="Email accounts"
            description="IONOS first, with an SMTP/IMAP adapter that can accept another provider later. App-configured sending limits are shown exactly as configured."
          >
            <EmailAccountsManager
              accounts={accounts}
              usages={usages}
              health={health}
              sendMode={sendMode}
            />
          </SettingsSection>

          <SettingsSection
            id="deepseek"
            icon={Sparkles}
            eyebrow="Autonomous discovery"
            title="DeepSeek research provider"
            description="The engine that finds, verifies and saves qualified trading-signal providers without an open browser or chat session. It never sends email."
          >
            <DeepSeekSettings initial={deepseekSettings} />
            <ProvidersCard initial={researchProviders} />
          </SettingsSection>

          <SettingsSection
            id="integrations"
            icon={Bot}
            eyebrow="MCP + REST"
            title="ChatGPT, Claude and Hermes"
            description="One shared database, one skill document, separate scoped keys. Research assistants can save verified work but can never send email or alter system policy."
          >
            <IntegrationsManager
              keys={apiKeys}
              appUrl={appUrl}
              aiProvider={aiProvider}
              hasOpenAI={Boolean(process.env.OPENAI_API_KEY)}
              hasAnthropic={Boolean(process.env.ANTHROPIC_API_KEY)}
            />
          </SettingsSection>

          <SettingsSection
            id="team"
            icon={UsersRound}
            eyebrow="Independent authentication"
            title="Users"
            description="Growth has its own user and session store, entirely separate from the main Nomeriq app."
          >
            <TeamManager users={users} />
          </SettingsSection>

          <SettingsSection
            id="privacy"
            icon={ShieldCheck}
            eyebrow="Compliance and retention"
            title="Suppression and data controls"
            description="Opt-outs are recorded immediately, checked before every send, and never overridden by an AI tool."
          >
            <div className="space-y-6">
              <SuppressionManager suppressions={suppressions} />
              <div className="border-t border-line pt-5">
                <BackupPanel />
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            id="system"
            icon={SlidersHorizontal}
            eyebrow="Runtime facts"
            title="System status"
            description="Facts, not marketing. These values come from the running environment."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                {
                  label: "Application URL",
                  value: appUrl,
                  icon: SlidersHorizontal,
                },
                {
                  label: "Database",
                  value: process.env.DATABASE_URL
                    ? "PostgreSQL / Supabase"
                    : "Local embedded Postgres (PGlite)",
                  icon: Database,
                },
                {
                  label: "Send mode",
                  value:
                    sendMode === "live"
                      ? "Live SMTP enabled"
                      : "Sandbox — no message leaves Growth",
                  icon: Mail,
                },
                {
                  label: "AI mode",
                  value:
                    aiProvider === "none"
                      ? "Deterministic writer, no AI key"
                      : `${aiProvider} · optional`,
                  icon: Bot,
                },
                {
                  label: "Follow-up cron",
                  value: process.env.CRON_SECRET
                    ? "Configured (drafts only)"
                    : "Not configured",
                  icon: SlidersHorizontal,
                },
                {
                  label: "MCP endpoint",
                  value: `${appUrl}/api/mcp`,
                  icon: KeyRound,
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-xl border border-line bg-white/50 p-3.5"
                >
                  <div className="flex items-center gap-1.5 text-12 font-bold uppercase tracking-[0.1em] text-faint">
                    <item.icon size={10} />
                    {item.label}
                  </div>
                  <div className="mt-1 break-all text-12 leading-5 text-ink">
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-forest/15 bg-lime/10 px-3.5 py-3 text-12 leading-5 text-forest">
              <strong>Independence:</strong> Growth has its own database,
              authentication, encrypted mailbox credentials and deployment. It
              does not read or write the main Nomeriq production database, AWS
              workers or auth system, and it keeps operating if Nomeriq is offline.
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
              <span className="text-12 text-faint">
                Nomeriq Growth · internal build v0.1
              </span>
              <a href="/api/health" target="_blank" className="text-12 font-semibold text-muted hover:text-ink">
                Health check →
              </a>
            </div>
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
