import { NextResponse } from "next/server";
import { databaseReady } from "@/lib/services/prospects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await databaseReady();
  return NextResponse.json(
    {
      ok: db,
      service: "nomeriq-growth",
      database: db ? "reachable" : "unreachable",
      sendMode: process.env.EMAIL_DELIVERY_MODE || "sandbox",
      timestamp: new Date().toISOString(),
    },
    { status: db ? 200 : 503 },
  );
}
