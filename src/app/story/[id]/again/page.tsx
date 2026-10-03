import { notFound } from "next/navigation";

import { getStoryOr404, printerName, requireUser, storyRef } from "@/lib/authz";
import { listActiveBenefits } from "@/lib/benefits";
import { availableCatalog } from "@/lib/catalog-data";
import { AppHeader } from "@/components/app-header";
import { Kicker, Notice } from "@/components/ui";
import { UploadForm } from "@/app/upload/upload-form";

export const dynamic = "force-dynamic";

/**
 * Print an old ticket again — with the wish open for changes first.
 *
 * "Print again" used to be one click that cloned the ticket exactly. But the
 * second go is rarely the first one repeated: the test print was too weak, or
 * the wrong colour, or one was not enough. Cloning meant filing a request the
 * requester already knew was wrong and then explaining the difference in a
 * comment. So it lands here instead: the request form, without the dropzone,
 * filled in with what was asked for last time.
 *
 * Yours only. The read is scoped, so someone else's ticket is a 404, and so is
 * the owner's view of a ticket they did not ask for — being able to see a
 * request is not being the person whose request it is to repeat. The endpoint
 * the form posts to checks all of this again.
 */
export default async function PrintAgainPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const storyId = Number(id);
  if (!Number.isInteger(storyId) || storyId <= 0) notFound();

  const user = await requireUser(`/story/${storyId}/again`);
  const story = await getStoryOr404(storyId, user);
  if (story.uploader.id !== user.id) notFound();

  const [owner, catalog, activeBenefits] = await Promise.all([
    printerName(),
    availableCatalog(),
    listActiveBenefits(),
  ]);
  const benefits = activeBenefits.map((b) => ({ label: b.label, preferred: b.preferred }));
  const ref = storyRef(story.id);

  return (
    <>
      <AppHeader user={user} active="/history" />
      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <div className="max-w-[780px]">
          <Kicker>Print {ref} again</Kicker>
          <h1 className="m-0 mb-[13.2px] break-words text-[46px] leading-[0.98] text-ink">
            Same again?
          </h1>
          <p className="m-0 mb-[26.4px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
            This opens a fresh request from the file on {ref}. It starts as you
            asked for it last time — change whatever should be different.{" "}
            {ref} itself stays exactly as it is.
          </p>
        </div>
        {catalog.length > 0 ? (
          <UploadForm
            owner={owner}
            catalog={catalog}
            benefits={benefits}
            again={{
              id: story.id,
              ref,
              filename: story.filename,
              fileSize: story.fileSize,
              title: story.title,
              material: story.material,
              colorName: story.colorName,
              quantity: story.quantity,
              tip: story.tip,
              note: story.note,
              printSettings: story.printSettings,
            }}
          />
        ) : (
          <div className="max-w-[780px]">
            <Notice tone="warn">
              The printer owner has not listed any available material and colour combinations yet.
            </Notice>
          </div>
        )}
      </main>
    </>
  );
}
