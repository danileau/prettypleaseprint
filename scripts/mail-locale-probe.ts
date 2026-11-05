/**
 * A notification email is written in its recipient's language.
 *
 * Run by `verify:queue`, never by hand, as a child process:
 *
 *   tsx --import ./scripts/_server-only.mjs scripts/mail-locale-probe.ts
 *
 * The stack under test ships English alone, so nobody there can be written to
 * in another language. This drives the app's own `notify` in process instead,
 * from the recipient's `preferredLocale` to the message in Mailpit, with a
 * catalogue it writes to `messages/xx.json` for the length of the run.
 *
 * What this does not exercise is the built app: here `tsx` resolves the
 * catalogue import at run time from the file on disk, where the deployed
 * server finds it in the map the bundler made at build time. `full-test.sh`'s
 * `messages-bundled` step checks that map against messages/ in the built
 * image; nothing sends mail from the image in a second language until one
 * ships.
 *
 * `xx` is in no one's LOCALES, so it is added to the list here, in this
 * process only — after checking that, before it is added, the same file is
 * ignored: only a listed language is used. The file is gitignored, removed if
 * a killed run left it, and removed again on the way out.
 *
 * Waits for each message to reach Mailpit before going on, because `notify`
 * sends without awaiting — the point of it — and exiting first would cut the
 * send off. Prints one `PROBE {…}` line for the parent.
 */
import "./_env";

import { rmSync, writeFileSync } from "node:fs";

const FIXTURE = "messages/xx.json";

async function main() {
  rmSync(FIXTURE, { force: true });
  writeFileSync(
    FIXTURE,
    JSON.stringify({
      notification: {
        storyMoved: "{actor} a déplacé « {title} » vers {status, select, Printing {Impression} other {{status}}}.",
      },
      mail: {
        notification: {
          openRef: "Ouvrir {ref}",
          // Broken on purpose: a lost brace. It must read in English, not as
          // `mail.notification.greeting`.
          greeting: "SALUT {name",
        },
      },
    }),
  );
  try {
    const { LOCALES } = await import("../src/i18n/locales");
    const { voiceFor } = await import("../src/lib/email");
    const unlisted = (await voiceFor("xx")).lang;
    (LOCALES as unknown as string[]).push("xx");

    const { notify } = await import("../src/lib/authz");
    const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
    const storyId = Number(process.env.PROBE_STORY_ID);
    const caught = async () =>
      ((await (await fetch(`${mailpit}/api/v1/messages?limit=200`)).json()) as { messages: { Subject: string }[] })
        .messages.filter((m) => m.Subject.includes("Probe bracket")).length;

    // One at a time: each send is waited for in Mailpit before the next event,
    // so two connections are never opened to it from the host at once.
    for (const recipientId of (process.env.PROBE_RECIPIENTS ?? "").split(",").filter(Boolean)) {
      const before = await caught();
      await notify({
        recipientId,
        actorId: process.env.PROBE_ACTOR_ID!,
        storyId,
        message: { key: "storyMoved", values: { actor: "Ruben", title: "Probe bracket", status: "Printing" } },
      });
      for (const end = Date.now() + 10_000; Date.now() < end && (await caught()) === before; ) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    console.info(`PROBE ${JSON.stringify({ unlisted })}`);
  } finally {
    rmSync(FIXTURE, { force: true });
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  rmSync(FIXTURE, { force: true });
  process.exit(1);
});
