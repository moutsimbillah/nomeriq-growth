/**
 * The instant a message really happened.
 *
 * `created_at` is the row's insert time, and for an imported row that is the import time — identical
 * for every row of that import, so it says nothing about the order the conversation happened in.
 * The real time is `sent_at`, falling back to `received_at`, and only then `created_at`; that is the
 * same convention `listSentMessages` and `listUnknownInbound` already use.
 */
export function messageRealTime(alias = ""): string {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return `COALESCE(${column("sent_at")}, ${column("received_at")}, ${column("created_at")})`;
}

/**
 * The order a thread is read in: newest first, by the time each message really happened.
 *
 * `id` breaks a tie, so two messages with the same instant never swap places between renders.
 * Lives here rather than in the conversation service so the follow-up and agent-context queries can
 * share it without importing the conversation service, which imports them.
 */
export function newestMessageFirst(alias = ""): string {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return [
    `${messageRealTime(alias)} DESC`,
    `${column("created_at")} DESC`,
    `${column("id")} DESC`,
  ].join(", ");
}