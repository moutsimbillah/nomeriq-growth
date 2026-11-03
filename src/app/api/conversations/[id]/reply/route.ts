import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { sendReply } from "@/lib/services/conversations";
import { AppError } from "@/lib/utils";
import type { EmailAttachmentInput } from "@/lib/email/send-provider";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const attachmentSchema = z.object({
  filename: z.string().min(1).max(180),
  contentType: z.string().min(1).max(120),
  dataBase64: z.string().min(1),
});

const schema = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(30000),
  accountId: z.string().uuid().optional().nullable(),
  attachments: z.array(attachmentSchema).max(3).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      throw new AppError(
        "An Idempotency-Key header is required so a double-click cannot send twice.",
        400,
        "idempotency_required",
      );
    }
    const input = schema.parse(await readJson(request));
    const attachments: EmailAttachmentInput[] = [];
    let total = 0;
    for (const attachment of input.attachments ?? []) {
      const content = Buffer.from(attachment.dataBase64, "base64");
      total += content.length;
      if (content.length > 2 * 1024 * 1024) {
        throw new AppError("Each attachment must be under 2 MB.");
      }
      if (total > 3 * 1024 * 1024) {
        throw new AppError("Reply attachments must total less than 3 MB.");
      }
      attachments.push({
        filename: attachment.filename.replace(/[\r\n"]/g, "_"),
        contentType: attachment.contentType,
        content,
      });
    }
    const result = await sendReply({
      conversationId: id,
      subject: input.subject,
      body: input.body,
      accountId: input.accountId || null,
      actorUserId: user.id,
      idempotencyKey,
      attachments,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return fail(error);
  }
}
