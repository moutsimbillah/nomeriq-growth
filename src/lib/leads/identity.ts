import { domainFromUrl, normalizeHandle, normalizeWebsiteUrl } from "@/lib/utils";

/** Shared hosts identify accounts, never an entire business-owned website domain. */
const SHARED_HOSTS = new Set(["instagram.com", "youtube.com", "youtu.be", "t.me", "telegram.me", "telegram.org", "x.com", "twitter.com", "facebook.com", "fb.com", "linkedin.com", "linktr.ee", "beacons.ai", "taplink.cc", "bio.site", "discord.com", "discord.gg", "whatsapp.com", "wa.me"]);
export type IdentityPlatform = "instagram" | "youtube" | "telegram" | "x";
export interface SocialIdentity { platform: IdentityPlatform; url: string }
export function isSharedIdentityHost(value: string): boolean {
  const domain = domainFromUrl(value);
  return Boolean(domain && [...SHARED_HOSTS].some(host => domain === host || domain.endsWith(`.${host}`)));
}
export function businessDomain(value: string | null | undefined): string | null {
  return value && !isSharedIdentityHost(value) ? domainFromUrl(value) : null;
}
export function sharedProfileKey(value: string | null | undefined): string | null {
  if (!value || !isSharedIdentityHost(value)) return null;
  const normalized = normalizeWebsiteUrl(value);
  if (!normalized) return null;
  const u = new URL(normalized);
  if (!u.pathname.replaceAll("/", "")) return null;
  return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
}
export function socialKeys(input: { websiteUrl?: string | null; instagramUrl?: string | null; youtubeUrl?: string | null; telegramUrl?: string | null; xUrl?: string | null; socialAccounts?: SocialIdentity[] }): Record<IdentityPlatform, string[]> {
  const values: SocialIdentity[] = [...(input.socialAccounts ?? [])];
  for (const platform of ["instagram", "youtube", "telegram", "x"] as const) {
    const url = input[`${platform}Url`]; if (url) values.push({platform,url});
  }
  if (input.websiteUrl && isSharedIdentityHost(input.websiteUrl)) {
    const host = domainFromUrl(input.websiteUrl)!;
    const platform = host.endsWith("instagram.com") ? "instagram" : host.endsWith("youtube.com") ? "youtube" : ["t.me", "telegram.me"].includes(host) ? "telegram" : ["x.com", "twitter.com"].includes(host) ? "x" : null;
    if (platform) values.push({platform,url:input.websiteUrl});
  }
  const result: Record<IdentityPlatform,string[]> = {instagram:[],youtube:[],telegram:[],x:[]};
  for (const value of values) {
    const key = normalizeHandle(value.url,value.platform);
    if (key && !result[value.platform].includes(key)) result[value.platform].push(key);
  }
  return result;
}
