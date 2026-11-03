import { redirect } from "next/navigation";
import { getSessionUser, userCount } from "@/lib/auth/session";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/auth-forms";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = params.next;
  const count = await userCount();
  if (count === 0) redirect("/setup");
  const user = await getSessionUser();
  if (user) redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Your next customer is already trading."
      description="Sign in to the independent Growth workspace. Research, drafts, mailbox threads and founder decisions stay in one place."
      mode="login"
    >
      <LoginForm hasUsers={count > 0} next={next} />
    </AuthShell>
  );
}
