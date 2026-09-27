/**
 * How stored model files are laid out on disk.
 *
 * Two constants in one place, for the same reason `src/lib/upload-limits.ts`
 * exists: more than one thing has to agree about them, and they disagreed.
 *
 * `src/lib/storage.ts` writes files as the app, and
 * `scripts/export-storage.ts` writes them during the migration off object
 * storage. `storage.ts` is `server-only`, so the script cannot import from it,
 * and the two had drifted to 0644 and 0640 respectively — which meant a
 * migrated model was readable only by the app while a newly uploaded one was
 * readable by a backup. Half a decision is worse than either whole one.
 */

/**
 * Deliberately group- and world-readable.
 *
 * Postgres' data directory is mode 700 owned by uid 70, and the README has to
 * carry a paragraph explaining that you therefore cannot back it up as
 * yourself and must do it from inside a container. One such trap in a project
 * is enough. Models are not secret at rest — they are gated at the route by
 * the ownership check in `authz.ts`, and the bytes never sit in the web root.
 *
 * The cost is that *removing* the tree still needs root or a container, since
 * the directories belong to the app's uid. That is documented in
 * docs/deployment.md, and it is the lesser of the two annoyances: backups
 * happen often and deletions once.
 */
export const FILE_MODE = 0o644;

/** 755 so the volume can be walked by a backup that is not the app's user. */
export const DIR_MODE = 0o755;
