import { redirect } from "next/navigation";

/** The design-review address of the folder inbox; it now lives at /email. */
export default async function FoldersRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && key !== "tab") next.set(key, value);
  }
  const query = next.toString();
  redirect(`/email${query ? `?${query}` : ""}`);
}
