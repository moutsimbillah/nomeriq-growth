import { getSessionUser } from "@/lib/auth/session";
import { fullSkillFile, loaderSkillFile } from "@/lib/agent/skillFile";

export const dynamic = "force-dynamic";

/**
 * Downloads the Claude skill file as SKILL.md.
 *
 * `?format=loader` (the default) serves the short loader, which contains no research rules.
 * `?format=full` serves the same frontmatter with the complete current skill text.
 * Both begin with YAML frontmatter; `get_instructions` and the MCP resource keep the plain text.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return new Response("Sign in to download the assistant skill.", { status: 401 });
  }
  const format = new URL(request.url).searchParams.get("format") === "full" ? "full" : "loader";
  const body = format === "full" ? fullSkillFile() : loaderSkillFile();

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="SKILL.md"',
      "Cache-Control": "no-store",
    },
  });
}
