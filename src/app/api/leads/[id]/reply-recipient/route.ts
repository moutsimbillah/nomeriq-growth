import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireFounder } from '@/lib/auth/session';
import { assertSameOrigin } from '@/lib/auth/request';
import { fail, readJson } from '@/lib/api';
import { AppError } from '@/lib/utils';
import { getRecipientPolicy, setReplyRecipient } from '@/lib/services/recipient-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const idSchema = z.string().uuid();
const schema = z.object({ emailRowId: idSchema.nullable() }).strict();
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireFounder();
    z.object({}).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
    const { id } = await context.params;
    return NextResponse.json({ ok: true, data: await getRecipientPolicy(idSchema.parse(id)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return fail(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    if (new URL(request.headers.get('origin')!).origin !== new URL(request.url).origin) throw new AppError('Cross-origin request blocked.', 403, 'invalid_origin');
    const user = await requireFounder();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    return NextResponse.json({ ok: true, data: await setReplyRecipient(idSchema.parse(id), input.emailRowId, user.id) });
  } catch (error) { return fail(error); }
}
