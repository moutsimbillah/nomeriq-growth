import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { saveProductTruth } from "@/lib/services/settings";
import { fail, readJson } from "@/lib/api";
import { productTruthSaveSchema } from "@/lib/product-truth-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    // Same limits as before; shared with Product Truth JSON import so the two cannot drift.
    const input = productTruthSaveSchema.parse(await readJson(request));
    return NextResponse.json({
      ok: true,
      data: await saveProductTruth(input, user.id),
    });
  } catch (error) {
    return fail(error);
  }
}
