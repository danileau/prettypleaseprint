import { getTranslations } from "next-intl/server";

import { offeredLocales } from "@/i18n/catalogue";
import { SOURCE_LOCALE, languageName } from "@/i18n/locales";
import { authMethods } from "@/lib/auth-methods";
import { requireAdmin } from "@/lib/authz";
import { ipSource } from "@/lib/client-ip";
import { mailStatus } from "@/lib/email";
import { IMPORT_SOURCES, SOURCE_LABEL } from "@/lib/import-source";
import { sourceUrl } from "@/lib/runtime";
import { SETTING_KEYS, effectiveSettings, lockedFields, parseMailFrom, type SettingKey } from "@/lib/settings";
import { AppHeader } from "@/components/app-header";
import { Button, Input, Kicker, Label, Notice } from "@/components/ui";
import { Toast } from "@/components/toast";
import { saveSettingsAction, type SaveOutcome } from "./actions";

export const dynamic = "force-dynamic";

const OUTCOMES: readonly SaveOutcome[] = ["saved", "unchanged", "locked", "invalid", "unknown"];

/**
 * Settings — the few things about this instance the owner can change here
 * rather than in `.env.docker`, and a plain account of what the environment
 * sets (#104).
 *
 * What lives here is cosmetic, or a decision that is the owner's to make; what
 * stays in the environment is a secret, the auth origin, infrastructure, or a
 * security decision an operator should make on purpose, outside the app. A
 * variable that is set always wins, and its field is shown locked.
 *
 * Read-only for everything the environment holds, and never a secret: the
 * panel says whether mail is set up, not with what — the same rule as the
 * Mail page.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string; field?: string }>;
}) {
  const user = await requireAdmin();
  const { result, field } = await searchParams;
  const t = await getTranslations("adminSettings");

  const settings = await effectiveSettings();
  const locked = lockedFields(settings);
  const outcome = OUTCOMES.find((o) => o === result);
  const fieldName = SETTING_KEYS.find((k) => k === field);
  const toast = outcome === "saved" ? t("result.saved") : outcome === "unchanged" ? t("result.unchanged") : null;
  const error =
    outcome === "invalid" && fieldName === "importSources"
      ? t("result.invalidSources")
      : outcome === "invalid" && fieldName === "defaultLocale"
      ? t("result.invalidLocale")
      : outcome === "locked" || outcome === "invalid"
      ? t(`result.${outcome}`, { field: fieldName ? t(`fields.${fieldName}.label`) : t("result.aField") })
      : outcome === "unknown"
        ? t("result.unknown")
        : null;

  const methods = authMethods();
  const mail = await mailStatus();
  const proxy = ipSource();
  const tag = process.env.PPP_TAG?.trim() || null;
  const mailAddress =
    settings.mailFrom.kind === "named" ? settings.mailFrom.address : parseMailFrom(settings.mailFrom.header)?.address;
  const mono = (chunks: React.ReactNode) => <span className="font-mono">{chunks}</span>;
  const editable = SETTING_KEYS.filter((k) => !locked.has(k));

  /** "Set by X" under a field the environment pins; otherwise where the value came from. */
  const origin = (key: SettingKey) => (
    <p className="m-0 mt-[6px] text-[13.5px] leading-[1.5] text-ink-2" data-setting-source={settings[key].source}>
      {settings[key].source === "env"
        ? t.rich("lockedBy", { mono, name: settings[key].envVar })
        : settings[key].source === "db"
          ? t("fromHere")
          : key === "mailFromName" && settings[key].value === null
            ? t("fields.mailFromName.byDefaultNoName")
            : t("byDefault")}
    </p>
  );

  const term = "font-mono text-[11.5px] font-bold uppercase tracking-[0.08em] text-ink-3";
  const value = "m-0 break-words font-bold text-ink";

  return (
    <>
      <AppHeader user={user} active="/admin/settings" />
      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        {toast && <Toast>{toast}</Toast>}
        <div className="max-w-[780px]">
          <Kicker>{t("kicker")}</Kicker>
          <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">{t("title")}</h1>
          <p className="m-0 mb-[26.4px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">{t("intro")}</p>

          {error && (
            <div className="mb-[22px]">
              <Notice tone="warn">{error}</Notice>
            </div>
          )}

          {/* ---- what the owner sets ---- */}
          <form
            action={saveSettingsAction}
            className="rounded-panel border-[3px] border-ink bg-porcelain p-[22px] shadow-stamp"
          >
            {editable.map((key) => (
              <input key={key} type="hidden" name="fields" value={key} />
            ))}

            <div className="mb-[22px]" data-setting="passkeyRpName" data-locked={locked.has("passkeyRpName")}>
              <Label htmlFor="passkeyRpName">{t("fields.passkeyRpName.label")}</Label>
              <Input
                id="passkeyRpName"
                name={locked.has("passkeyRpName") ? undefined : "passkeyRpName"}
                defaultValue={settings.passkeyRpName.value}
                maxLength={64}
                autoComplete="off"
                disabled={locked.has("passkeyRpName")}
              />
              <p className="m-0 mt-[6px] text-[13.5px] leading-[1.5] text-ink-2">{t("fields.passkeyRpName.help")}</p>
              {origin("passkeyRpName")}
            </div>

            <div className="mb-[22px]" data-setting="mailFromName" data-locked={locked.has("mailFromName")}>
              <Label htmlFor="mailFromName">{t("fields.mailFromName.label")}</Label>
              <Input
                id="mailFromName"
                name={locked.has("mailFromName") ? undefined : "mailFromName"}
                defaultValue={settings.mailFromName.value ?? ""}
                placeholder={t("fields.mailFromName.noName")}
                maxLength={64}
                autoComplete="off"
                disabled={locked.has("mailFromName")}
              />
              <p className="m-0 mt-[6px] text-[13.5px] leading-[1.5] text-ink-2">
                {mailAddress
                  ? t.rich("fields.mailFromName.help", { mono, address: mailAddress })
                  : t("fields.mailFromName.helpNoAddress")}
              </p>
              {origin("mailFromName")}
            </div>

            {/* The instance's default language (#103): every language this
                build has but English, by its own name, as on /me — English
                is the empty option, the built-in default, and is not stored. */}
            <div className="mb-[22px]" data-setting="defaultLocale" data-locked={locked.has("defaultLocale")}>
              <Label htmlFor="defaultLocale">{t("fields.defaultLocale.label")}</Label>
              <select
                id="defaultLocale"
                name={locked.has("defaultLocale") ? undefined : "defaultLocale"}
                defaultValue={settings.defaultLocale.value ?? ""}
                disabled={locked.has("defaultLocale")}
                className="w-full cursor-pointer rounded-card border-[3px] border-ink bg-cream-2 px-[12px] py-[10px] text-[15px] text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">{t("fields.defaultLocale.builtIn")}</option>
                {offeredLocales()
                  .filter((code) => code !== SOURCE_LOCALE)
                  .map((code) => (
                    <option key={code} value={code} lang={code}>
                      {languageName(code) ?? code}
                    </option>
                  ))}
              </select>
              <p className="m-0 mt-[6px] text-[13.5px] leading-[1.5] text-ink-2">{t("fields.defaultLocale.help")}</p>
              {origin("defaultLocale")}
            </div>

            <fieldset
              className="m-0 mb-[22px] border-0 p-0"
              data-setting="importSources"
              data-locked={locked.has("importSources")}
            >
              <legend className="mb-[6px] block p-0 font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-ink-2">
                {t("fields.importSources.label")}
              </legend>
              {IMPORT_SOURCES.map((source) => (
                <label key={source} className="flex items-center gap-[9px] text-[15px] font-bold text-ink">
                  <input
                    type="checkbox"
                    name={locked.has("importSources") ? undefined : "importSources"}
                    value={source}
                    defaultChecked={settings.importSources.value.includes(source)}
                    disabled={locked.has("importSources")}
                    className="h-[18px] w-[18px] accent-cherry-dk"
                  />
                  {t("fields.importSources.option", { source: SOURCE_LABEL[source] })}
                </label>
              ))}
              <p className="m-0 mt-[6px] text-[13.5px] leading-[1.5] text-ink-2">{t("fields.importSources.help")}</p>
              {origin("importSources")}
            </fieldset>

            <div className="flex flex-wrap items-center gap-[13.2px]">
              <Button type="submit" disabled={editable.length === 0}>
                {t("save")}
              </Button>
              <span className="text-[13.5px] text-ink-2">{editable.length ? t("reauthNote") : t("allLocked")}</span>
            </div>
          </form>

          {/* ---- what the environment sets ---- */}
          <h2 className="m-0 mb-[13.2px] mt-[35.2px] font-display text-[26px] text-ink">{t("env.title")}</h2>
          <p className="m-0 mb-[17.6px] text-[15px] leading-[1.5] text-ink-2">{t.rich("env.intro", { mono })}</p>
          <section
            aria-label={t("env.title")}
            className="rounded-panel border-[3px] border-ink bg-porcelain p-[22px]"
            data-environment
          >
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-[22px] gap-y-[8.8px] text-[15px]">
              <dt className={term}>{t("env.signIn")}</dt>
              <dd className={value} data-env="auth-methods">
                {t("env.methods", { local: methods.local ? "on" : "off", oidc: methods.oidc ? "on" : "off" })}
              </dd>
              <dt className={term}>{t("env.origin")}</dt>
              <dd className={`${value} font-mono`}>{process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}</dd>
              <dt className={term}>{t("env.rpId")}</dt>
              <dd className={`${value} font-mono`}>{process.env.PASSKEY_RP_ID ?? "localhost"}</dd>
              <dt className={term}>{t("env.mail")}</dt>
              <dd className={value} data-env="mail">
                {t("env.mailTransport", { transport: mail.transport })}
              </dd>
              <dt className={term}>{t("env.proxy")}</dt>
              <dd className={value} data-env="proxy">
                {t("env.proxyMode", { mode: proxy })}
              </dd>
              <dt className={term}>{t("env.breachCheck")}</dt>
              <dd className={value}>
                {t("env.breachCheckState", { state: process.env.HIBP_DISABLED === "true" ? "off" : "on" })}
              </dd>
              <dt className={term}>{t("env.source")}</dt>
              <dd className={`${value} font-mono`}>{sourceUrl()}</dd>
              <dt className={term}>{t("env.tag")}</dt>
              <dd className={`${value} font-mono`} data-env="tag">
                {tag ?? t("env.tagUnset")}
              </dd>
            </dl>
            <p className="m-0 mt-[13.2px] text-[13.5px] leading-[1.5] text-ink-2">{t.rich("env.howToChange", { mono })}</p>
          </section>
        </div>
      </main>
    </>
  );
}
