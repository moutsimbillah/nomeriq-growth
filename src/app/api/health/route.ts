import { NextResponse } from "next/server";
import { buildInfo } from "@/lib/build-info";
import { databaseReady } from "@/lib/services/prospects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await databaseReady();
  const build = buildInfo();
  return NextResponse.json(
    {
      ok: db,
      service: "nomeriq-growth",
      database: db ? "reachable" : "unreachable",
      sendMode: process.env.EMAIL_DELIVERY_MODE || "sandbox",
      // Which build is actually serving this request. Read from the compiled bundle, not from the
      // working tree, so "is my change live?" is answerable with one request — a checked-out
      // commit that was never built reports the previous build's commit, not the new one.
      commit: build.commit,
      builtAt: build.builtAt,
      timestamp: new Date().toISOString(),
    },
    { status: db ? 200 : 503 },
  );
}
