"use client";

import { createContext, useContext } from "react";
import { DEFAULT_TIMEZONE } from "@/lib/dates/timezone";

const WorkspaceTimezoneContext = createContext<string>(DEFAULT_TIMEZONE);

export function WorkspaceTimezoneProvider({
  timezone,
  children,
}: {
  timezone: string;
  children: React.ReactNode;
}) {
  return (
    <WorkspaceTimezoneContext.Provider value={timezone}>
      {children}
    </WorkspaceTimezoneContext.Provider>
  );
}

export function useWorkspaceTimezone(): string {
  return useContext(WorkspaceTimezoneContext);
}
