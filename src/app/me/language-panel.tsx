import { getTranslations } from "next-intl/server";

import { offeredLocales } from "@/i18n/catalogue";
import { languageName } from "@/i18n/locales";
import { Notice } from "@/components/ui";
import { setLanguageAction } from "./actions";

/**
 * The person's own language, on /me: "Follow my browser", or one of the
 * languages this build offers — every file in messages/, English included,
 * each by its name in itself (`languageName`), so the list is the directory
 * and nothing else.
 *
 * A plain server-rendered form, so it works with JavaScript off like every
 * other form in the app, and no client component: no messages go to the
 * browser for it, and the words it renders are this person's own page's. The
 * select opens on what is stored; a stored language this build no longer has
 * shows as "Follow my browser", which is what the person is then getting
 * (`resolveLocale` passes over it).
 */
export async function LanguagePanel({ preference, status }: { preference: string | null; status?: string }) {
  const t = await getTranslations("me.language");
  const offered = offeredLocales();
  const current = preference && offered.includes(preference) ? preference : "";

  return (
    <section
      id="language"
      aria-labelledby="language-heading"
      className="mt-[35.2px] max-w-[780px] rounded-panel border-[3px] border-ink bg-porcelain p-[22px] shadow-stamp"
    >
      <h2 id="language-heading" className="m-0 mb-[6px] font-display text-[22px] text-ink">
        {t("heading")}
      </h2>
      {status === "refused" && (
        <div className="mb-[13.2px]">
          <Notice tone="warn">{t("refused")}</Notice>
        </div>
      )}
      <p className="m-0 mb-[13.2px] text-[15px] leading-[1.5] text-ink-2">{t("lead")}</p>
      <form action={setLanguageAction} className="flex flex-wrap items-center gap-[13.2px]">
        <select
          name="locale"
          defaultValue={current}
          aria-labelledby="language-heading"
          className="cursor-pointer rounded-card border-[3px] border-ink bg-cream-2 px-[12px] py-[10px] text-[15px] text-ink"
        >
          <option value="">{t("followBrowser")}</option>
          {offered.map((code) => (
            // `lang` on each, so a screen reader says "Deutsch" in German.
            <option key={code} value={code} lang={code}>
              {languageName(code) ?? code}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-porcelain px-[20px] py-[11px] text-[15px] font-semibold text-ink hover:bg-cream-2"
        >
          {t("save")}
        </button>
      </form>
    </section>
  );
}
