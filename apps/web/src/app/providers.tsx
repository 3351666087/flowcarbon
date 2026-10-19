"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { MaterialLight } from "@/components/glass";
import { Toaster } from "@/components/toast";
import { Updates } from "@/components/updates";
import { ApiError } from "@/lib/api";
import type { Locale } from "@/lib/format";
import { I18nProvider } from "@/lib/i18n";

export function Providers({ locale, children }: { locale: Locale; children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // client errors will not change on retry
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <I18nProvider initial={locale}>
        <MaterialLight />
        {children}
        <Updates />
        <Toaster />
      </I18nProvider>
    </QueryClientProvider>
  );
}
