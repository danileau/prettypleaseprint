import { requireAdmin } from "@/lib/authz";
import { listAllBenefits } from "@/lib/benefits";
import { AppHeader } from "@/components/app-header";
import { Kicker, Notice } from "@/components/ui";
import { Toast } from "@/components/toast";
import {
  createBenefitAction,
  renameBenefitAction,
  setActiveAction,
  setPreferredAction,
} from "./actions";

export const dynamic = "force-dynamic";

/**
 * Manage the benefits catalogue — the tips a requester can offer. Admin-only:
 * `requireAdmin` answers 404, so a client learns nothing about this route.
 *
 * Plain server-rendered forms, so the whole screen works with JavaScript off,
 * like the rest of the admin surfaces. A retired benefit is kept (not deleted)
 * so past requests that offered it still read correctly.
 */
export default async function BenefitsPage({
  searchParams,
}: {
  searchParams: Promise<{ toast?: string; error?: string }>;
}) {
  const [{ toast, error }, admin] = await Promise.all([searchParams, requireAdmin()]);
  const benefits = await listAllBenefits();

  const live = benefits.filter((b) => b.active);
  const retired = benefits.filter((b) => !b.active);

  return (
    <>
      <AppHeader user={admin} active="/admin/benefits" />

      <main className="mx-auto w-full max-w-[880px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Benefits</Kicker>
        <h1 className="m-0 mt-[6px] mb-[8px] font-display text-[30px] leading-[1.05] text-ink">
          What&rsquo;s in it for you
        </h1>
        <p className="m-0 mb-[22px] max-w-[62ch] text-[15px] text-ink-2">
          The tips people can offer when they ask for a print. Mark the ones you
          currently prefer — those are starred on the upload form so people know
          what you actually want. Retire one to take it off the list without
          touching past requests that offered it.
        </p>

        {error && (
          <div className="mb-[17.6px]">
            <Notice tone="warn">{error}</Notice>
          </div>
        )}

        {/* Add */}
        <form
          action={createBenefitAction}
          className="mb-[26.4px] flex flex-wrap items-end gap-[8.8px] rounded-panel border-[3px] border-ink bg-aqua-wash p-[17.6px] shadow-stamp"
        >
          <div className="flex-[1_1_240px]">
            <label htmlFor="new-benefit" className="mb-[6px] block font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-ink-2">
              Add a benefit
            </label>
            <input
              id="new-benefit"
              name="label"
              required
              maxLength={80}
              autoComplete="off"
              placeholder="A round of coffees"
              className="w-full rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[11px] text-[16px] text-ink placeholder:text-ink-3"
            />
          </div>
          <button
            type="submit"
            className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[22px] py-[11px] text-[15px] font-bold text-cream hover:bg-cherry"
          >
            Add
          </button>
        </form>

        {/* Live list */}
        <div className="flex flex-col gap-[11px]">
          {live.map((b) => (
            <div
              key={b.id}
              className="rounded-card border-[3px] border-ink bg-porcelain p-[15px] shadow-stamp"
            >
              <div className="flex flex-wrap items-center gap-[8.8px]">
                {/* Rename (inline) */}
                <form action={renameBenefitAction} className="flex flex-[1_1_240px] items-center gap-[8px]">
                  <input type="hidden" name="id" value={b.id} />
                  {b.preferred && (
                    <span aria-hidden className="text-[18px] leading-none text-cherry-dk">★</span>
                  )}
                  <input
                    name="label"
                    defaultValue={b.label}
                    maxLength={80}
                    aria-label={`Rename ${b.label}`}
                    className="min-w-[140px] flex-1 rounded-[8px] border-[3px] border-ink bg-cream-2 px-[11px] py-[7px] font-bold text-[15px] text-ink"
                  />
                  <button
                    type="submit"
                    className="cursor-pointer rounded-chip border-2 border-ink bg-porcelain px-[12px] py-[6px] font-mono text-[11px] font-bold uppercase text-ink hover:bg-sun"
                  >
                    Save
                  </button>
                </form>

                {/* Toggle preferred */}
                <form action={setPreferredAction}>
                  <input type="hidden" name="id" value={b.id} />
                  <input type="hidden" name="preferred" value={b.preferred ? "false" : "true"} />
                  <button
                    type="submit"
                    className={`stamp cursor-pointer rounded-chip border-[3px] border-ink px-[13px] py-[7px] text-[13px] font-bold ${
                      b.preferred ? "bg-cherry-dk text-cream hover:bg-cherry" : "bg-porcelain text-ink hover:bg-sun"
                    }`}
                  >
                    {b.preferred ? "★ Preferred" : "Mark preferred"}
                  </button>
                </form>

                {/* Retire */}
                <form action={setActiveAction}>
                  <input type="hidden" name="id" value={b.id} />
                  <input type="hidden" name="active" value="false" />
                  <button
                    type="submit"
                    className="cursor-pointer rounded-chip border-2 border-ink bg-cream-2 px-[12px] py-[6px] font-mono text-[11px] font-bold uppercase text-ink-2 hover:bg-cherry-wash"
                  >
                    Retire
                  </button>
                </form>
              </div>
            </div>
          ))}
          {live.length === 0 && (
            <p className="m-0 rounded-card border-[3px] border-dashed border-ink-3 bg-cream-2 px-[15px] py-[13.2px] font-mono text-[12px] uppercase tracking-[0.05em] text-ink-3">
              No benefits on the list — add one above, or nobody can offer a tip.
            </p>
          )}
        </div>

        {/* Retired */}
        {retired.length > 0 && (
          <section className="mt-[35.2px]">
            <h2 className="m-0 mb-[13.2px] font-display text-[20px] text-ink">Retired</h2>
            <div className="flex flex-col gap-[8.8px]">
              {retired.map((b) => (
                <div
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-[8.8px] rounded-card border-[3px] border-ink bg-cream-2 px-[15px] py-[11px] opacity-80"
                >
                  <span className="font-bold text-[15px] text-ink-2 line-through">{b.label}</span>
                  <form action={setActiveAction}>
                    <input type="hidden" name="id" value={b.id} />
                    <input type="hidden" name="active" value="true" />
                    <button
                      type="submit"
                      className="cursor-pointer rounded-chip border-2 border-ink bg-porcelain px-[12px] py-[6px] font-mono text-[11px] font-bold uppercase text-ink hover:bg-mint-wash"
                    >
                      Restore
                    </button>
                  </form>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {toast && <Toast>{toast}</Toast>}
    </>
  );
}
