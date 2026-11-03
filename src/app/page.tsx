import { redirect } from "next/navigation";
import { getSessionUser, userCount } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if ((await userCount()) === 0) redirect("/setup");
  const user = await getSessionUser();
  redirect(user ? "/dashboard" : "/login");
}
