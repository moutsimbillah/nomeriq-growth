"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, LoaderCircle, Plus, Trash2 } from "lucide-react";

import { Notice } from "../ui";
import { apiRequest, InlineError } from "../client-ui";
import { PROVIDER_CATALOG } from "@/lib/ai/provider-catalog";

export interface TaskView {
  task: string;
  label: string;
  providerId: string | null;
  providerName: string | null;
  model: string | null;
  searchProviderId: string | null;
  searchProviderName: string | null;
  fallbacks: { providerId: string; providerName: string; priority: number }[];
  updatedAt: string | null;
}

export interface ProviderOption {
  id: string;
  name: string;
  kinds: string;
  model: string;
  isEnabled: boolean;
}

/** A provider that can serve a chat task: it is not search-only and it names a model. */
function canChat(provider: ProviderOption): boolean {
  return provider.kinds !== "search" && provider.model.trim().length > 0;
}

/** A provider that can be a search source: anything that is not model-only. */
function canSearch(provider: ProviderOption): boolean {
  return provider.kinds !== "chat";
}

/**
 * The provider catalog — which provider slugs exist and what each defaults to — lives in
 * `@/lib/ai/provider-catalog` and is imported by both the server registry and this screen, so the
 * two cannot drift. What is shown here is filtered with the same rules the API enforces: a
 * search-only provider (Brave) is not offered for a chat task and a model-only provider is not
 * offered as the search source, and an option that cannot be chosen says why.
 */
export function AiTasksCard({
  initialTasks,
  providers,
}: {
  initialTasks: TaskView[];
  providers: ProviderOption[];
}) {
  const [tasks, setTasks] = useState<TaskView[]>(initialTasks);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Fallback lists are edited locally then saved with the task, so the order is what is stored.
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});

  function fallbacksFor(task: TaskView): string[] {
    return drafts[task.task] ?? task.fallbacks.map((entry) => entry.providerId);
  }

  async function save(task: TaskView, body: Record<string, unknown>, label: string) {
    setError(null);
    setNotice(null);
    setPending(label);
    try {
      const data = (await apiRequest("/api/settings/ai-tasks", {
        body: { task: task.task, ...body },
      })) as { tasks?: TaskView[] } | null;
      if (data?.tasks) setTasks(data.tasks);
      setNotice(`${task.label} saved.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setPending(null);
    }
  }

  function saveFallbacks(task: TaskView) {
    return save(task, { fallbackProviderIds: fallbacksFor(task), ...currentOf(task) }, `fb-${task.task}`);
  }

  /** Re-sends the task's current provider and model, so a fallback change never clears them. */
  function currentOf(task: TaskView) {
    return { providerId: task.providerId, model: task.model, searchProviderId: task.searchProviderId };
  }

  function setFallbacks(task: TaskView, next: string[]) {
    setDrafts((current) => ({ ...current, [task.task]: next }));
  }

  const chatOptions = providers.filter(canChat);
  const searchOptions = providers.filter(canSearch);
  const blocked = providers.filter((provider) => !canChat(provider));

  return (
    <div className="mt-4 rounded-xl border border-line bg-white/50 px-3.5 py-3">
      <div className="text-12 font-bold text-ink">Which provider serves each task</div>
      <p className="text-12 text-muted">
        Each AI action uses the provider chosen here. Until something is chosen, the action falls
        back to the environment configuration, or to the built-in template when there is none.
      </p>

      {providers.length === 0 && (
        <p className="mt-3 text-12 text-faint">
          Add a provider above first — there is nothing to choose from yet.
        </p>
      )}

      {providers.length > 0 && (
        <div className="mt-3 space-y-2">
          {tasks.map((task) => {
            const expanded = open === task.task;
            const chain = fallbacksFor(task);
            const chainNames = chain
              .map((id) => providers.find((provider) => provider.id === id)?.name)
              .filter(Boolean)
              .join(" → ");

            return (
              <div key={task.task} className="rounded-lg border border-line/70 px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setOpen(expanded ? null : task.task)}
                  >
                    <div className="text-12 font-bold text-ink">{task.label}</div>
                    <div className="truncate text-12 text-faint">
                      {task.providerName ?? "Not configured"}
                      {task.model ? ` · ${task.model}` : ""}
                      {task.searchProviderName ? ` · search: ${task.searchProviderName}` : ""}
                      {!expanded && chainNames ? ` · fallback: ${chainNames}` : ""}
                    </div>
                  </button>

                  <select
                    className="input w-56 text-12"
                    value={task.providerId ?? ""}
                    disabled={pending === `task-${task.task}`}
                    onChange={(event) => {
                      const providerId = event.target.value || null;
                      const chosen = providers.find((provider) => provider.id === providerId);
                      void save(
                        task,
                        {
                          providerId,
                          model: chosen ? chosen.model : null,
                          searchProviderId: task.searchProviderId,
                        },
                        `task-${task.task}`,
                      );
                    }}
                  >
                    <option value="">Not configured</option>
                    {chatOptions.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                        {provider.isEnabled ? "" : " (disabled)"}
                      </option>
                    ))}
                    {task.providerId &&
                      !chatOptions.some((provider) => provider.id === task.providerId) && (
                        <option value={task.providerId}>
                          {task.providerName ?? "Unavailable"} (cannot serve this task)
                        </option>
                      )}
                  </select>

                  {pending === `task-${task.task}` && (
                    <LoaderCircle size={13} className="spin text-muted" />
                  )}
                </div>
                {expanded && (
                  <div className="mt-2 space-y-2 border-t border-line/60 pt-2">
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="text-12 text-muted">
                        Model
                        <input
                          className="input mt-1 w-56 text-12"
                          defaultValue={task.model ?? ""}
                          placeholder={task.providerId ? "" : "choose a provider first"}
                          disabled={!task.providerId}
                          onBlur={(event) => {
                            const model = event.target.value.trim() || null;
                            if (model === (task.model ?? null)) return;
                            void save(task, { ...currentOf(task), model }, `model-${task.task}`);
                          }}
                        />
                      </label>

                      <label className="text-12 text-muted">
                        Search source
                        <select
                          className="input mt-1 w-56 text-12"
                          value={task.searchProviderId ?? ""}
                          onChange={(event) =>
                            void save(
                              task,
                              {
                                ...currentOf(task),
                                searchProviderId: event.target.value || null,
                              },
                              `search-${task.task}`,
                            )
                          }
                        >
                          <option value="">The model&apos;s own search</option>
                          {searchOptions.map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div>
                      <div className="text-12 text-muted">
                        Fallback order — tried when the chosen provider fails
                      </div>
                      {chain.length === 0 ? (
                        <p className="text-12 text-faint">Nothing in the chain. The task fails if the chosen provider fails.</p>
                      ) : (
                        <ol className="mt-1 space-y-1">
                          {chain.map((id, index) => {
                            const name =
                              providers.find((provider) => provider.id === id)?.name ?? "(deleted)";
                            return (
                              <li key={id} className="flex items-center gap-2 text-12">
                                <span className="text-faint">{index + 1}.</span>
                                <span className="min-w-0 flex-1 truncate text-ink">{name}</span>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={index === 0}
                                  onClick={() => {
                                    const next = [...chain];
                                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                    setFallbacks(task, next);
                                  }}
                                  aria-label={`Move ${name} up`}
                                >
                                  <ArrowUp size={12} />
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={index === chain.length - 1}
                                  onClick={() => {
                                    const next = [...chain];
                                    [next[index + 1], next[index]] = [next[index], next[index + 1]];
                                    setFallbacks(task, next);
                                  }}
                                  aria-label={`Move ${name} down`}
                                >
                                  <ArrowDown size={12} />
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => setFallbacks(task, chain.filter((entry) => entry !== id))}
                                  aria-label={`Remove ${name}`}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </li>
                            );
                          })}
                        </ol>
                      )}

                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <select
                          className="input w-56 text-12"
                          defaultValue=""
                          onChange={(event) => {
                            const id = event.target.value;
                            if (id && !chain.includes(id)) setFallbacks(task, [...chain, id]);
                            event.target.value = "";
                          }}
                        >
                          <option value="">Add a fallback…</option>
                          {chatOptions
                            .filter((provider) => !chain.includes(provider.id))
                            .filter((provider) => provider.id !== task.providerId)
                            .map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.name}
                              </option>
                            ))}
                        </select>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void saveFallbacks(task)}
                          disabled={pending === `fb-${task.task}`}
                        >
                          {pending === `fb-${task.task}` ? (
                            <LoaderCircle size={12} className="spin" />
                          ) : (
                            <Plus size={12} />
                          )}
                          Save fallback order
                        </button>
                      </div>
                    </div>

                    {task.updatedAt && (
                      <div className="text-12 text-faint">
                        Last changed {new Date(task.updatedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {blocked.length > 0 && (
        <p className="mt-3 text-12 text-faint">
          {blocked
            .map((provider) =>
              provider.kinds === "search"
                ? `${provider.name} is search-only, so it can only be chosen as a search source.`
                : `${provider.name} has no model set, so it is not offered for a chat task.`,
            )
            .join(" ")}
        </p>
      )}

      <InlineError>{error}</InlineError>
      {notice && <Notice tone="success">{notice}</Notice>}
    </div>
  );
}
