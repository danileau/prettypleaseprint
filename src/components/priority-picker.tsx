import { PRIORITY_CHIP } from "@/lib/catalog";

/**
 * Change a ticket's priority: three buttons, the current one filled in.
 *
 * It was a `<select>` with a "Set" button beside it. The closed box could be
 * dressed to match, but the list a select opens is drawn by the operating
 * system — square, grey, in the system font — and nothing in CSS reaches it,
 * so the one control on the page that popped open looked like it belonged to a
 * different app. Three choices do not need a menu anyway: this is the same
 * segmented shape the request form uses for material and quantity.
 *
 * Still a plain form, so it works with JavaScript off. Each button is a submit
 * carrying `name="priority"`, which is how a form with several buttons says
 * which one was pressed — one click instead of choose-then-Set.
 *
 * **No field here may be called `id`.** With JavaScript on, React submits the
 * form itself and adds the pressed button's value by inserting a temporary
 * input, which it ties to the form by reading `form.id`. A control named `id`
 * shadows that property — `form.id` becomes the input element — so the
 * temporary input is attached to a form that does not exist and the button's
 * value is silently left out. The request then arrives with no priority at
 * all. It only happens in a real browser: a plain form post, which is what the
 * suites send, is unaffected. Refused below, loudly, because the symptom
 * ("That is not a priority" on a button that plainly says one) points nowhere
 * near the cause.
 */
export function PriorityPicker({
  action,
  fields,
  options,
  current,
}: {
  action: (formData: FormData) => Promise<void>;
  /** Hidden fields the action needs — the ticket's id, where to land. */
  fields: Record<string, string | number>;
  options: readonly string[];
  current: string;
}) {
  if ("id" in fields) {
    throw new Error(
      "PriorityPicker: a hidden field named `id` shadows form.id and drops the pressed button's value — name it something else.",
    );
  }

  return (
    <form
      action={action}
      className="mt-[17.6px] border-t-2 border-dashed border-rule pt-[17.6px]"
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p
        id="change-priority"
        className="m-0 mb-[6px] font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink-3"
      >
        Change priority
      </p>
      <div role="group" aria-labelledby="change-priority" className="flex max-w-[360px] flex-wrap gap-[6px]">
        {options.map((option) => {
          const active = option === current;
          return (
            <button
              key={option}
              type="submit"
              name="priority"
              value={option}
              aria-pressed={active}
              className={`flex-1 cursor-pointer rounded-chip border-[3px] border-ink px-[10px] py-[8px] font-mono text-[12.5px] font-bold uppercase tracking-[0.06em] transition-colors ${
                active ? "bg-cherry-dk text-cream" : "bg-porcelain text-ink hover:bg-sun"
              }`}
            >
              {PRIORITY_CHIP[option]?.label ?? option}
            </button>
          );
        })}
      </div>
    </form>
  );
}
