import { getSessionUser } from "@/lib/auth/session";
import { exportWorkspaceBackup } from "@/lib/services/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const user = await getSessionUser();
  if (!user || !["founder", "admin"].includes(user.role)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const backup = await exportWorkspaceBackup();
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(backup, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="nomeriq-growth-backup-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
