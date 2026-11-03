import { getSessionUser } from "@/lib/auth/session";
import { ASSISTANT_SKILL } from "@/lib/agent/instructions";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return new Response("Sign in to download the assistant skill.", { status: 401 });
  }
  return new Response(ASSISTANT_SKILL, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="nomeriq-growth-assistant-skill.md"',
      "Cache-Control": "no-store",
    },
  });
}
