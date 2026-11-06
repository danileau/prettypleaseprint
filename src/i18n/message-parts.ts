/* Pure: imported by scripts/check-messages.ts and the suites. */

/**
 * What a translation has to keep from English: the names of an ICU message's
 * arguments (`{name}`, `{count, plural, …}`, `{status, select, …}`) and of its
 * rich-text tags (`<strong>…</strong>`, `<link>…</link>`).
 *
 * A small reader rather than a pattern, because the words inside a `select`'s
 * branches — `Printing {Impression}` — are text to translate, not arguments,
 * and a branch's key (`Printing`) is English's to choose, not the
 * translation's. Lost tags matter as much as lost arguments: the template
 * fills `<link>` in with the address to switch emails off, and a translation
 * without it silently drops the link.
 */
export function partsOf(message: string): { args: string[]; tags: string[] } {
  const args = new Set<string>();
  const tags = new Set<string>();
  let i = 0;
  const ident = () => {
    const m = /^\s*([A-Za-z_][\w-]*)\s*/.exec(message.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[1]!;
  };
  // Message text up to `stop` ("}" closing a branch, or the end).
  const text = (nested: boolean): void => {
    while (i < message.length) {
      const c = message[i]!;
      if (c === "}" && nested) return;
      if (c === "{") {
        i++;
        const name = ident();
        if (name) args.add(name);
        if (message[i] === ",") {
          i++;
          const type = ident();
          if (type === "select" || type === "plural" || type === "selectordinal") {
            if (message[i] === ",") i++;
            // options: key {message} … until the argument's own "}"
            while (i < message.length && message[i] !== "}") {
              const m = /^\s*(=?[^\s{}]+)\s*/.exec(message.slice(i));
              if (!m) break;
              i += m[0].length;
              if (message[i] !== "{") break;
              i++;
              text(true);
              i++; // the branch's "}"
              while (/\s/.test(message[i] ?? "")) i++;
            }
          } else {
            while (i < message.length && message[i] !== "}") i++; // number, date … styles
          }
        } else {
          while (i < message.length && message[i] !== "}") i++;
        }
        i++; // the argument's "}"
        continue;
      }
      if (c === "<") {
        const m = /^<\/?([A-Za-z][\w-]*)\s*\/?>/.exec(message.slice(i));
        if (m) {
          tags.add(m[1]!);
          i += m[0].length;
          continue;
        }
      }
      if (c === "#") {
        i++;
        continue;
      }
      i++;
    }
  };
  text(false);
  return { args: [...args].sort(), tags: [...tags].sort() };
}

