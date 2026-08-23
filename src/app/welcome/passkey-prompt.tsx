"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, Notice } from "@/components/ui";

type State = "idle" | "working" | "done" | "error";

export function PasskeyPrompt({ deviceHint }: { deviceHint: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" && !!window.PublicKeyCredential,
    );
  }, []);

  async function add() {
    setState("working");
    setMessage(null);

    const res = await authClient.passkey.addPasskey({ name: deviceHint });

    if (res?.error) {
      // A cancelled system prompt is a choice, not a failure — say so plainly.
      setState("error");
      setMessage(
        res.error.message ??
          "That did not complete. You can always add one later.",
      );
      return;
    }
    setState("done");
  }

  if (!supported) {
    return (
      <div className="flex flex-col gap-[17.6px]">
        <Notice>
          This browser does not do passkeys. Your username and password work
          everywhere, which is why they are the way in.
        </Notice>
        <Button onClick={() => router.push("/")}>Take me in</Button>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div className="flex flex-col gap-[17.6px]">
        <Notice tone="good">
          Passkey saved. Next time, signing in is a fingerprint or a face — no
          password to type. It still works if you would rather.
        </Notice>
        <Button onClick={() => router.push("/")}>Take me in</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[17.6px]">
      <Button onClick={add} disabled={state === "working"} className="w-full">
        {state === "working" ? "Waiting for your device…" : "Add a passkey"}
      </Button>

      {message && <Notice tone="warn">{message}</Notice>}

      {/* Honest about the consequence. The old copy said "Skip for now" and
          then never mentioned it again, which is how people ended up typing a
          password every time without ever choosing to. */}
      <button
        type="button"
        onClick={() => router.push("/")}
        className="cursor-pointer self-center text-[13.5px] font-bold text-ink-2 underline underline-offset-2 hover:text-cherry-dk"
      >
        Not now — keep typing my password
      </button>
    </div>
  );
}
