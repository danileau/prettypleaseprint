# Materials and colours

[← back to the README](../README.md)

The printer owner manages the choices shown on the request form at
`/admin/catalog`. A material is offered only when it is turned on and has at
least one active colour. Arrows set the order in which materials and colours
appear.

Turning an entry off is temporary. Removing it deletes the catalogue row; when
a material is removed, its colour rows go with it. Neither operation changes
an existing ticket because every request snapshots its material label, colour
label, representative hex, rendered swatch, and swatch mode when submitted.

## Swatch types

- **Solid** takes one colour.
- **Gradient** takes a start and end colour.
- **Whatever** takes no colour input. It renders as a rainbow with a question
  mark and keeps that behavior even if its display name is changed.

The mode is stored separately from the editable colour name. No particular
spelling has hidden behavior.

## Validation

The request form is only a convenience. At submission time the server looks up
the posted material and colour together and accepts them only when both rows
are still active and related. A stale or hand-written form therefore cannot
request a combination the owner no longer offers.

`npm run verify:catalog` drives the real admin forms and upload endpoint. It is
destructive and should only target a development database; the suite restores
the default catalogue before it exits.
