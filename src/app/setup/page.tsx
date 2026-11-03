import { redirect } from "next/navigation";
import { getSessionUser, userCount } from "@/lib/auth/session";
import { AuthShell } from "@/components/auth-shell";
import { SetupForm } from "@/components/auth-forms";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const count = await userCount();
  if (count > 0) redirect("/login");
  const user = await getSessionUser();
  if (user) redirect("/dashboard");

  return (
    <AuthShell
      eyebrow="First run"
      title="Build the workspace once."
      description="Create the founder account for this independent Growth database. It has its own authentication, its own credentials and no connection to the main Nomeriq application."
      mode="setup"
    >
      <SetupForm />
    </AuthShell>
  );
}
