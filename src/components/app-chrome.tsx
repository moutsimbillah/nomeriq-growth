"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  BookOpenCheck,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Radar,
  Settings2,
  UsersRound,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "./ui";
import { Wordmark } from "./logo";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/research", label: "Research", icon: Radar },
  { href: "/leads", label: "Leads", icon: UsersRound },
  { href: "/email", label: "Email", icon: Mail },
  { href: "/product-truth", label: "Product Truth", icon: BookOpenCheck },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

export function AppChrome({
  children,
  user,
  sendMode,
  mailboxLabel,
  productTruthReady,
}: {
  children: ReactNode;
  user: { name: string; email: string; role: string };
  sendMode: "sandbox" | "live";
  mailboxLabel: string | null;
  productTruthReady: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    <>
      <div className="flex h-[78px] items-center justify-between px-5">
        <Link href="/dashboard" onClick={() => setMobileOpen(false)}>
          <Wordmark />
        </Link>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white lg:hidden"
          aria-label="Close navigation"
        >
          <X size={17} />
        </button>
      </div>

      <div className="px-3">
        <div className="mb-2 px-3 text-[9px] font-bold uppercase tracking-[0.2em] text-white/26">
          Workspace
        </div>
        <nav className="space-y-0.5">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn("nav-link", isActive(item.href) && "nav-link-active")}
            >
              <item.icon size={16} strokeWidth={1.8} />
              <span>{item.label}</span>
              <ChevronRight
                size={12}
                className="ml-auto text-white/20"
                strokeWidth={2}
              />
            </Link>
          ))}
        </nav>
      </div>

      <div className="mx-3 mt-6 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-white/32">
            Send mode
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide",
              sendMode === "live"
                ? "bg-lime/20 text-lime"
                : "bg-amber/20 text-[#f5c976]",
            )}
          >
            <span
              className={cn(
                "h-1 w-1 rounded-full",
                sendMode === "live" ? "bg-lime" : "bg-[#f5c976]",
              )}
            />
            {sendMode}
          </span>
        </div>
        <p className="mt-2 truncate text-[10.5px] leading-4 text-white/44">
          {mailboxLabel || "No mailbox connected"}
        </p>
        {!productTruthReady && (
          <Link
            href="/product-truth"
            className="mt-2.5 block rounded-lg bg-amber/10 px-2.5 py-1.5 text-[10px] font-semibold text-[#f1c474] hover:bg-amber/15"
          >
            Product Truth needs review
          </Link>
        )}
      </div>

      <div className="mt-auto p-3">
        <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.035] px-2.5 py-2.5">
          <Avatar name={user.name} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11.5px] font-semibold text-white/90">
              {user.name}
            </div>
            <div className="truncate text-[9.5px] text-white/35">{user.email}</div>
          </div>
          <button
            type="button"
            onClick={logout}
            className="rounded-full p-1.5 text-white/35 transition hover:bg-white/10 hover:text-white"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-white/[0.06] bg-forest lg:flex">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(350px_250px_at_30%_0%,rgba(201,243,109,0.08),transparent_70%)]" />
        <div className="relative flex h-full flex-col">{nav}</div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-forest/40 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          />
          <aside className="relative flex h-full w-[270px] flex-col bg-forest shadow-2xl">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(350px_250px_at_30%_0%,rgba(201,243,109,0.08),transparent_70%)]" />
            <div className="relative flex h-full flex-col">{nav}</div>
          </aside>
        </div>
      )}

      <div className="lg:pl-[248px]">
        <div className="sticky top-0 z-20 flex h-[62px] items-center justify-between border-b border-line bg-paper/90 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="btn-ghost btn-sm -ml-1"
            aria-label="Open navigation"
          >
            <Menu size={18} />
          </button>
          <Wordmark compact />
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide",
              sendMode === "live"
                ? "bg-forest/10 text-forest"
                : "bg-amber/10 text-amber",
            )}
          >
            {sendMode}
          </span>
        </div>
        <main className="mx-auto min-h-screen w-full max-w-[1500px] overflow-x-clip px-4 py-6 sm:px-7 lg:px-9 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
