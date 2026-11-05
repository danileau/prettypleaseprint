/**
 * The groups of messages client components ask for with `useTranslations`,
 * per screen. Only these are sent to the browser, and only on the screen that
 * renders those components: the header hands its own to its menus, the
 * sign-in page to its form (`getClientMessages` in ./server.ts).
 *
 * `waysIn` is the single sign-on button and the "or" between two ways in
 * (src/components/sso-button.tsx), on every screen that offers a choice of
 * how to sign in: signing in, accepting an invitation, confirming it is you.
 *
 * Not the whole catalogue, and not one list for every page, and the reason is
 * not size. Messages sent to a client component travel in the page's RSC
 * payload, readable in its source by whoever loads it. Sent from the root
 * layout, every page — the sign-in page included, to someone not signed in —
 * would carry every word in the app, the owner's navigation among them, and
 * the suites assert on the raw HTML that an owner-only label is *absent* from
 * a client's page (verify:auth). Words only the owner sees are therefore
 * never in a group: the server picks them and passes them as props.
 *
 * A client component that asks for a group not listed here would render the
 * key's name. `npm run check:messages` reads every `useTranslations("…")` in a
 * "use client" file and fails when one is not covered, so add the group here
 * in the same change. Pure, so that script can import it.
 */
export const CLIENT_GROUPS = {
  header: ["header.activity", "header.account", "header.nudge"],
  signin: ["signin.form", "waysIn"],
  invite: ["waysIn"],
  reauth: ["waysIn"],
} as const;
