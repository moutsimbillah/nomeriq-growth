import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/utils";

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(
      { ok: false, error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        ok: false,
        error: error.issues.map((issue) => issue.message).join("; "),
        code: "validation_error",
      },
      { status: 400 },
    );
  }
  console.error("Unhandled API error", error);
  return NextResponse.json(
    {
      ok: false,
      error: "Something went wrong. Check the server log for details.",
      code: "internal_error",
    },
    { status: 500 },
  );
}

export async function readJson<T = Record<string, unknown>>(
  request: Request,
): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AppError("Request body must be valid JSON.", 400, "invalid_json");
  }
}
