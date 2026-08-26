import { printerName, requireUser } from "@/lib/authz";
import { listActiveBenefits } from "@/lib/benefits";
import { AppHeader } from "@/components/app-header";
import { Kicker } from "@/components/ui";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const user = await requireUser("/upload");
  const owner = await printerName();
  // The tip options are owner-managed now; the form renders from these.
  const benefits = (await listActiveBenefits()).map((b) => ({
    label: b.label,
    preferred: b.preferred,
  }));

  return (
    <>
      <AppHeader user={user} active="/upload" />
      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <div className="max-w-[780px]">
          <Kicker>New order</Kicker>
          {/* Still a sentence someone would say out loud — which was the
              point of the original H1, and survives the rename. */}
          {/* Still a sentence someone would say out loud, which was the point
              of the original H1 and survives both the rename and the redesign. */}
          <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">
            Pretty please print
          </h1>
          <p className="m-0 mb-[26.4px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
            Drop an <span className="font-mono">.stl</span> or{" "}
            <span className="font-mono">.3mf</span>. {owner} gets a ping, and
            your order goes up on the rail as a ticket you can follow.
          </p>
        </div>
        <UploadForm owner={owner} benefits={benefits} />
      </main>
    </>
  );
}
