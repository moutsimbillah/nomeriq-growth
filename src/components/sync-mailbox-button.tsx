"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { apiRequest } from "./client-ui";

export function SyncMailboxButton({
  accountId,
  className,
  label = "Sync mailbox",
}: {
  accountId: string;
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sync() {
    setPending(true);
    setMessage(null);
    try {
      const result = await apiRequest(
        `/api/email/accounts/${accountId}/sync`,
        { method: "POST" },
      );
      if (result?.sandbox) {
        setMessage("Sandbox mailbox: use a conversation’s test-reply control.");
      } else {
        setMessage(
          `${result.imported} imported, ${result.skipped} skipped${
            result.errors?.length ? `, ${result.errors.length} errors` : ""
          }.`,
        );
      }
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={sync}
        disabled={pending}
        className={className || "btn-secondary btn-sm"}
      >
        <RefreshCw size={13} className={pending ? "spin" : ""} />
        {pending ? "Syncing…" : label}
      </button>
      {message && (
        <span className="max-w-[300px] text-right text-12 leading-4 text-faint">
          {message}
        </span>
      )}
    </div>
  );
}
