/**
 * Which languages the app speaks.
 *
 * Pure on purpose — no `next/headers`, no next-intl — so the check scripts and
 * the types in ./app-config.d.ts can import it without dragging the request
 * machinery along. docs/i18n.md is the guide.
 */

/**
 * English first, and English is the default: `messages/en.json` is the source
 * of truth that every other catalogue is checked against
 * (`npm run check:messages`).
 *
 * English is the only one for now. docs/i18n.md has the steps for adding a
 * language, and they start here.
 */
export const LOCALES = ["en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/*
 * How a language will be chosen once there is more than one, so that the
 * order is decided before anything depends on it:
 *
 *   1. the person's own choice — `User.preferredLocale`, set on /me;
 *   2. what the browser asks for — `Accept-Language`;
 *   3. the instance's default — from the settings page the owner edits (#104);
 *   4. English.
 *
 * A person's choice beats their browser because they made it in this app; the
 * instance default comes after the browser because it is a guess about a
 * stranger, and the browser is better placed to make that guess. None of the
 * three is read yet: with one language there is nothing to choose, and every
 * read would be a query or a header parse for an answer that is always "en".
 */
