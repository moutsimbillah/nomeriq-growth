import { AGENT_TAGS, CHANNEL_TAGS } from "@/lib/agent/agentTag";
import { ADDED_RANGES, parsePktDate, type AddedRange } from "@/lib/dates/pakistan";
import type { AgentTag, ChannelTag } from "@/lib/types";

/**
 * The leads filters, in one place, so the URL and the SQL always agree.
 *
 * Only known values survive: an unknown `agent` in the address bar is dropped rather than passed to
 * the query, so a bookmarked or hand-edited link cannot ask for something that does not exist.
 */

export interface LeadFilters {
  query?: string;
  status?: string;
  category?: string;
  qualification?: string;
  jobId?: string;
  agent?: AgentTag;
  channel?: ChannelTag;
  /** Asia/Karachi day window the row was added in. */
  added?: AddedRange;
  /** Only meaningful with `added: "custom"`, as YYYY-MM-DD in Asia/Karachi. */
  addedFrom?: string;
  addedTo?: string;
}

export type LeadFilterParams = Record<string, string | undefined>;

const AGENT_SET = new Set<string>(AGENT_TAGS);
const CHANNEL_SET = new Set<string>(CHANNEL_TAGS);
const ADDED_SET = new Set<string>(ADDED_RANGES);

export function readLeadFilters(params: LeadFilterParams): LeadFilters {
  const agent = params.agent && AGENT_SET.has(params.agent) ? (params.agent as AgentTag) : undefined;
  const channel =
    params.channel && CHANNEL_SET.has(params.channel) ? (params.channel as ChannelTag) : undefined;

  // A custom range is only a range with both ends: with one end missing, fall back to no date filter
  // rather than a half-open window that silently means something else.
  let added = params.added && ADDED_SET.has(params.added) ? (params.added as AddedRange) : undefined;
  const addedFrom = parsePktDate(params.from) ? params.from : undefined;
  const addedTo = parsePktDate(params.to) ? params.to : undefined;
  if (added === "custom" && (!addedFrom || !addedTo)) added = undefined;

  return {
    query: params.q?.trim() || undefined,
    status: params.status || undefined,
    category: params.category || undefined,
    qualification: params.qualification || undefined,
    jobId: params.job || undefined,
    agent,
    channel,
    added,
    addedFrom: added === "custom" ? addedFrom : undefined,
    addedTo: added === "custom" ? addedTo : undefined,
  };
}

/** The query string a filtered view is bookmarked as. Empty values are omitted. */
export function leadFilterQuery(filters: LeadFilters): string {
  const search = new URLSearchParams();
  if (filters.query) search.set("q", filters.query);
  if (filters.status) search.set("status", filters.status);
  if (filters.category) search.set("category", filters.category);
  if (filters.qualification) search.set("qualification", filters.qualification);
  if (filters.jobId) search.set("job", filters.jobId);
  if (filters.agent) search.set("agent", filters.agent);
  if (filters.channel) search.set("channel", filters.channel);
  if (filters.added) search.set("added", filters.added);
  if (filters.added === "custom") {
    if (filters.addedFrom) search.set("from", filters.addedFrom);
    if (filters.addedTo) search.set("to", filters.addedTo);
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function countActiveFilters(filters: LeadFilters): number {
  return [
    filters.query,
    filters.status,
    filters.category,
    filters.qualification,
    filters.jobId,
    filters.agent,
    filters.channel,
    filters.added,
  ].filter(Boolean).length;
}