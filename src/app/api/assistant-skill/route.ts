import { getSessionUser } from "@/lib/auth/session";
import { buildSkillDownload, isSkillFormat, isSkillPlatform } from "@/lib/agent/skillFile";

export const dynamic = "force-dynamic";

/** Authenticated downloads; absent parameters preserve the legacy Claude loader. */
export async function GET(request: Request) {
  const errorHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  const user = await getSessionUser();
  if (!user) {
    return new Response("Sign in to download the assistant skill.", { status: 401, headers: errorHeaders });
  }

  const params = new URL(request.url).searchParams;
  const platform = params.get("platform") ?? "claude";
  const format = params.get("format") ?? "loader";
  if (
    params.getAll("platform").length > 1 ||
    params.getAll("format").length > 1 ||
    !isSkillPlatform(platform) ||
    !isSkillFormat(format)
  ) {
    return new Response("Invalid assistant skill platform or format.", { status: 400, headers: errorHeaders });
  }

  const download = buildSkillDownload(platform, format);
  return new Response(download.body, {
    headers: {
      ...errorHeaders,
      "Content-Type": download.contentType,
      "Content-Disposition": `attachment; filename="${download.filename}"`,
    },
  });
}
