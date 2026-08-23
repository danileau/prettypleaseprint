import { printerName, requireUser } from "@/lib/authz";
import { AppHeader } from "@/components/app-header";
import { Kicker } from "@/components/ui";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const user = await requireUser("/upload");
  const owner = await printerName();

  return (
    <>
      <AppHeader user={user} active="/upload" />
      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <div className="max-w-[780px]">
          <Kicker>New request</Kicker>
          {/* Still a sentence someone would say out loud — which was the
              point of the original H1, and survives the rename. */}
          <h1 className="m-0 mb-[13.2px] text-[42px] font-semibold leading-[1.05] tracking-[-0.02em]">
            Pretty please print
          </h1>
          <p className="m-0 mb-[26.4px] text-[17px] leading-[1.5] text-muted-3 text-pretty">
            Drop an <span className="font-mono">.stl</span> or{" "}
            <span className="font-mono">.3mf</span>. {owner} gets a ping, and
            your request shows up in the backlog as a story you can follow.
          </p>
        </div>
        <UploadForm owner={owner} />
      </main>
    </>
  );
}
