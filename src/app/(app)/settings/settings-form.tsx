"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface Preferences {
  emailEnabled: boolean;
  notifyBackInStock: boolean;
  notifyPriceDrop: boolean;
  subsequentDropPct: number | null;
}

export function SettingsForm({
  email,
  preferences: initial,
}: {
  email: string;
  preferences: Preferences;
}) {
  const router = useRouter();
  const [preferences, setPreferences] = useState<Preferences>(initial);
  const [subsequentDrop, setSubsequentDrop] = useState(
    initial.subsequentDropPct?.toString() ?? "",
  );
  const [pending, startTransition] = useTransition();

  function save(partial: Partial<Preferences>) {
    const next = { ...preferences, ...partial };
    setPreferences(next);
    startTransition(async () => {
      const response = await fetch("/api/settings/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailEnabled: next.emailEnabled,
          notifyBackInStock: next.notifyBackInStock,
          notifyPriceDrop: next.notifyPriceDrop,
          subsequentDropPct: subsequentDrop,
        }),
      });
      if (response.ok) {
        router.refresh();
        toast.success("Preferences saved");
      } else {
        toast.error("Could not save preferences");
      }
    });
  }

  function saveSubsequentDrop() {
    const value = subsequentDrop.trim();
    if (value !== "" && (Number(value) < 1 || Number(value) > 99)) {
      toast.error("Must be a whole percentage between 1 and 99, or empty");
      return;
    }
    startTransition(async () => {
      const response = await fetch("/api/settings/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subsequentDropPct: value,
        }),
      });
      if (response.ok) {
        router.refresh();
        toast.success("Preferences saved");
      } else {
        toast.error("Could not save preferences");
      }
    });
  }

  function sendTestEmail() {
    startTransition(async () => {
      const response = await fetch("/api/settings/test-email", { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        toast.success(`Test email sent to ${email}`);
      } else {
        toast.error(data.error ?? "Test email failed to send");
      }
    });
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Your sign-in details.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Label htmlFor="email">Email address</Label>
          <Input id="email" value={email} readOnly disabled />
          <p className="text-xs text-muted-foreground">
            Notifications are sent to this address.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email notifications</CardTitle>
          <CardDescription>
            Control which monitoring events send you email.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Email notifications</p>
              <p className="text-sm text-muted-foreground">
                Master switch for all monitoring emails.
              </p>
            </div>
            <Switch
              checked={preferences.emailEnabled}
              onCheckedChange={(checked) => save({ emailEnabled: checked })}
              disabled={pending}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Back-in-stock emails</p>
              <p className="text-sm text-muted-foreground">
                Notify when a product becomes available again.
              </p>
            </div>
            <Switch
              checked={preferences.notifyBackInStock}
              onCheckedChange={(checked) => save({ notifyBackInStock: checked })}
              disabled={pending}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Price-drop emails</p>
              <p className="text-sm text-muted-foreground">
                Notify when a product reaches your target price.
              </p>
            </div>
            <Switch
              checked={preferences.notifyPriceDrop}
              onCheckedChange={(checked) => save({ notifyPriceDrop: checked })}
              disabled={pending}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="subsequentDrop">Subsequent price drops</Label>
            <div className="flex gap-2">
              <Input
                id="subsequentDrop"
                type="number"
                min={1}
                max={99}
                placeholder="e.g. 5"
                value={subsequentDrop}
                onChange={(event) => setSubsequentDrop(event.target.value)}
                className="max-w-32"
              />
              <Button
                variant="outline"
                onClick={saveSubsequentDrop}
                disabled={pending}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Optional: after a price-drop notification, email again when the
              price falls at least this percentage further. Leave empty to
              disable.
            </p>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={sendTestEmail} disabled={pending} variant="outline">
            Send test email
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
