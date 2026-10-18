"use client";

import { Suspense } from "react";
import { AuthFlow } from "@/components/auth-flow";

export default function LoginPage() {
  return (
    <Suspense>
      <AuthFlow />
    </Suspense>
  );
}
