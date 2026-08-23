import { headers } from "next/headers";
import { requireUser } from "@/lib/authz";
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
  const ua = (await headers()).get("user-agent");

  return (
    <AuthShell>
      <Kicker>You are in</Kicker>
      <H1>Welcome, {user.name.split(" ")[0]}</H1>
      <Lead>
        One last thing worth thirty seconds: save a passkey. It replaces the
        emailed link with your fingerprint, face or device PIN, and it cannot be
        phished the way a link in an inbox can.
      </Lead>
      <PasskeyPrompt deviceHint={deviceLabel(ua)} />
    </AuthShell>
  );
}
