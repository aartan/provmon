import type { Metadata } from "next";

import { RegisterCard } from "@/app/(auth)/register/register-card";

export const metadata: Metadata = {
  title: "Create account",
};

export default function RegisterPage() {
  return <RegisterCard />;
}
