import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireFounder } from '@/lib/auth/session';
import { assertSameOrigin } from '@/lib/auth/request';
import { fail, readJson } from '@/lib/api';
import { AppError } from '@/lib/utils';
import { decideMessageLink, getMessageLinkSuggestions } from '@/lib/services/message-linking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const idSchema = z.string().uuid();
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), prospectId: idSchema, confirmSharedAddress: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('unlink'), prospectId: idSchema.optional(), detachAddress: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('reject'), prospectId: idSchema, detachAddress: z.boolean().optional() }).strict(),
]);
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireFounder();
    const { id } = await context.params;
    const params = z.object({ q: z.string().max(100).optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
    return NextResponse.json({ ok: true, data: await getMessageLinkSuggestions(idSchema.parse(id), params.q) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return fail(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    if (new URL(request.headers.get('origin')!).origin !== new URL(request.url).origin) throw new AppError('Cross-origin request blocked.', 403, 'invalid_origin');
    const user = await requireFounder();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    return NextResponse.json({ ok: true, data: await decideMessageLink(idSchema.parse(id), input, user.id) });
  } catch (error) { return fail(error); }
}
