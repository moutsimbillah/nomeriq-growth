/** Infrastructure/accounting failures must not become candidate rejections or paid retries. */
export class ResearchAccountingError extends Error {
  constructor() {
    super("Research accounting failed. Further provider attempts stopped.");
    this.name = "ResearchAccountingError";
  }
}
export function isResearchAccountingError(error: unknown): error is ResearchAccountingError {
  return error instanceof Error && error.name === "ResearchAccountingError";
}
