import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { authMethods } from "@/lib/auth-methods";
import { AuthShell, H1, Kicker, Lead } from "@/components/ui";
import { PasskeyPrompt } from "./passkey-prompt";

export const dynamic = "force-dynamic";

/** A rough, human label so a list of passkeys is readable later. */
function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "This device";
  if (/iPhone|iPad/i.test(userAgent)) return "iPhone or iPad";
  if (/Android/i.test(userAgent)) return "Android device";
  if (/Macintosh/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows PC";
  if (/Linux/i.test(userAgent)) return "Linux machine";
  return "This device";
}

export default async function WelcomePage() {
  const user = await requireUser("/welcome");
  // This page exists to offer a passkey. Where they are off there is nothing
  // to offer, and the board is where people are going anyway.
  if (!authMethods().local) redirect("/board");
  const ua = (await headers()).get("user-agent");

  return (
    <AuthShell>
      <Kicker>You&rsquo;re in</Kicker>
      <H1>Welcome, {user.name.split(" ")[0]}</H1>
      <Lead>
        One last thing worth thirty seconds: save a passkey. It puts your
        fingerprint, face or device PIN where the password goes, and unlike a
        password there is nothing to phish, reuse or forget.
      </Lead>
      <PasskeyPrompt deviceHint={deviceLabel(ua)} />
    </AuthShell>
  );
}
