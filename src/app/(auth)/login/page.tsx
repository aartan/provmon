import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginCard } from "@/app/(auth)/login/login-card";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
  return (
    <Suspense>
      <LoginCard />
    </Suspense>
  );
}
