import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  AI_TASKS,
  AI_TASK_LABELS,
  PROVIDER_KINDS,
  listAiProviders,
} from "@/lib/ai/registry";
import { listTaskSettings, saveTaskSetting } from "@/lib/services/ai-task-settings";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which provider and model serve each AI task, and in what fallback order. */
export async function GET() {
  try {
    await requireEditor();
    return NextResponse.json({
      ok: true,
      data: {
        tasks: await listTaskSettings(),
        providers: await listAiProviders(),
        providerKinds: PROVIDER_KINDS,
        taskLabels: AI_TASK_LABELS,
        validTasks: AI_TASKS,
      },
    });
  } catch (error) {
    return fail(error);
  }
}

const saveSchema = z.object({
  task: z.string().min(1).max(60),
  providerId: z.string().uuid().nullable().optional(),
  model: z.string().max(300).nullable().optional(),
  searchProviderId: z.string().uuid().nullable().optional(),
  fallbackProviderIds: z.array(z.string().uuid()).max(10).optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = saveSchema.parse(await readJson(request));
    // `task` is validated against the known list inside saveTaskSetting, which refuses an unknown
    // task by name — a zod enum here would report it as a generic schema failure instead.
    const tasks = await saveTaskSetting(
      input.task,
      {
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        searchProviderId: input.searchProviderId ?? null,
        ...(input.fallbackProviderIds ? { fallbackProviderIds: input.fallbackProviderIds } : {}),
      },
      user.id,
    );
    return NextResponse.json({ ok: true, data: { tasks } });
  } catch (error) {
    return fail(error);
  }
}
