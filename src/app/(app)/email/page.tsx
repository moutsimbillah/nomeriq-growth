import { EmailToolsPage } from "./email-tools";
import { FolderInbox } from "./folder-inbox";

export const dynamic = "force-dynamic";

/**
 * `/email` is the folder inbox. `/email?tab=…` opens the email tools (Mailbox list, Sent, Drafts,
 * Campaigns, Follow-ups) exactly as before, so every existing link keeps working.
 */
export default async function EmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  if (params.tab) return <EmailToolsPage searchParams={Promise.resolve(params)} />;
  return <FolderInbox params={params} />;
}
