export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    if (candidate.cause) return errorCode(candidate.cause);
  }
  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    errorCode(error) === "23505" ||
    (error instanceof Error && /duplicate key|unique constraint/i.test(error.message))
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
