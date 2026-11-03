import { getSessionUser } from "@/lib/auth/session";
import { getAttachment } from "@/lib/services/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await context.params;
  const attachment = await getAttachment(id);
  if (!attachment) return new Response("Attachment not found", { status: 404 });
  return new Response(new Uint8Array(attachment.content), {
    headers: {
      "Content-Type": attachment.contentType,
      "Content-Disposition": `attachment; filename="${attachment.filename.replace(/["\r\n]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "Content-Length": String(attachment.content.length),
    },
  });
}
