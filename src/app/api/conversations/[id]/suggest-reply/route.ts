import { keepAliveJson } from "@/lib/ai/keep-alive-json";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { suggestConversationReply } from "@/lib/services/conversations";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Up to three full-context attempts (120s each) plus short retry pauses.
export const maxDuration = 420;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    return keepAliveJson(
      async () => ({ ok: true, data: await suggestConversationReply(id) }),
      async error => fail(error).json(),
    );
  } catch (error) {
    return fail(error);
  }
}
