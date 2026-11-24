/**
 * A notification email is written in its recipient's language.
 *
 * Run by `verify:queue`, never by hand, as a child process:
 *
 *   tsx --import ./scripts/_server-only.mjs scripts/mail-locale-probe.ts
 *
 * Not through the languages the stack ships, whose words change as they are
 * translated: this drives the app's own `notify` in process, from the
 * recipient's `preferredLocale` to the message in Mailpit, with a catalogue it
 * writes to `messages/vo.json` for the length of the run — one whose strings,
 * and broken message, are the test's own. Volapük because it has to be a
 * language the app would offer (Intl names it; `xx` it does not, and is left
 * out like `notes.json`) and one no catalogue here will ever be.
 *
 * What this does not exercise is the built app: here `tsx` lists and reads
 * messages/ from disk, where the deployed server finds the catalogues in the
 * map the bundler made at build time (src/i18n/catalogue.ts). `full-test.sh`'s
 * `messages-bundled` step checks that map against messages/ in the built
 * image, and verify:auth serves every shipped language from it.
 *
 * A language is a file, so the probe also says what `vo` was before the file
 * existed — not a language: English — and after, with no other change. The
 * file is gitignored, removed if a killed run left it, and removed again on
 * the way out.
 *
 * Waits for each message to reach Mailpit before going on, because `notify`
 * sends without awaiting — the point of it — and exiting first would cut the
 * send off. Prints one `PROBE {…}` line for the parent.
 */
import "./_env";

import { rmSync, writeFileSync } from "node:fs";

const FIXTURE = "messages/vo.json";

async function main() {
  rmSync(FIXTURE, { force: true });
  const { voiceFor } = await import("../src/lib/email");
  const absent = (await voiceFor("vo")).lang;
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
    const present = (await voiceFor("vo")).lang;

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
    console.info(`PROBE ${JSON.stringify({ absent, present })}`);
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
