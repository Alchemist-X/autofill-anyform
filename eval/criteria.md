# AutoFill AnyForm — Eval Criteria (verbatim copy)

Run the harness as: `node eval/eval.mjs` (from repo root).

Since the extension cannot run in a browser here, the matcher logic MUST be extracted
into a PURE importable ESM module (e.g. `content/match.mjs` exporting
`matchField(descriptor, profile) -> {key, confidence}`) so it is unit-testable; the
content script imports it.

## C1 — lint / manifest
- `node --check` passes on every `.js` / `.mjs` in the extension (excluding `eval/` and `node_modules/`).
- `manifest.json` parses as valid MV3 (`manifest_version === 3`, has `name`, `version`, `action`/`background`).
- Every manifest-referenced file exists (popup, options, background service worker, content scripts, web_accessible_resources, action icons).
- The 3 icons exist (icon16.png, icon48.png, icon128.png).

## C2 — CORRECTNESS matcher (the mis-fill bug)
`matchField(descriptor, profile)` (imported from the pure module) MUST map correctly:
- "Email"            -> email
- "Phone"            -> phone
- "Company Name"     -> company   (NOT firstName / fullName)
- "City"             -> city
- "ZIP/Postal Code"  -> postalCode
- "Job Title"        -> jobTitle   (NOT a name field)
- "Title"            -> jobTitle   (NOT a name field)

And it MUST NOT mis-map:
- "Cardholder Name"  -> MUST NOT map to fullName / firstName (return null or LOW confidence).
- "Username"         -> MUST NOT map to fullName.

## C3 — word-boundary / specificity
A generic "name" rule must NOT greedily match "Company Name" / "Username" /
"Cardholder Name". Matching uses word boundaries / specificity ranking:
- "Company Name"    -> company   (specific beats generic "name")
- "Username"        -> NOT fullName
- "Cardholder Name" -> NOT fullName / firstName

## C4 — confidence
`matchField` returns a confidence number. Ambiguous / uncertain descriptors are
flagged LOW confidence (not silently treated as a confident fill):
- A clear field (e.g. "Email") returns HIGH confidence.
- An ambiguous / no-match descriptor (e.g. "Cardholder Name", "xyzzy") returns
  null or a LOW confidence (below the fill threshold), never a confident wrong fill.

## C5 — field-type helpers
Pure, importable, unit-tested helpers exist for:
- `<select>`: match an option by text/value -> chosen option value (or null).
- checkbox: coerce a profile value to a boolean.
- radio: choose a radio value from a group by value/label.
- date: normalize a profile value to an ISO `YYYY-MM-DD` string.
These must be importable (no DOM dependency) and behave deterministically.

## C6 — LLM apply path
The function that APPLIES an LLM `field -> profileKey` mapping is importable and
unit-testable with a mock mapping (the apply step was previously stubbed). Given a
mock mapping `{ "0": "email", "1": null, ... }`, a list of field descriptors, and a
profile, it produces the per-field values to write (resolving profile keys, skipping
nulls / empty values). No DOM, no network.

## C7 — tests
`node --test` runs >= 6 tests covering the matcher cases in C2/C3 + helpers (C5) +
LLM-apply (C6). All tests pass.

## C8 — packaging / docs
- README has precise "load unpacked" steps (chrome://extensions, Developer mode,
  Load unpacked, select folder with manifest.json).
- A `package.json` exists with an npm `build:zip` script that produces a loadable
  `.zip` of the extension using NO external dependencies (Node-only). The harness
  runs the script and verifies a `.zip` is produced containing `manifest.json`.

## AESTHETIC (implemented; judged later, not pass/fail here)
- popup + options keep the polished modern design + dark mode.

---

## Harness behavior
- Prints `PASS Cx: ...` or `FAIL Cx: <why>` for each criterion.
- Ends with `RESULT: X/Y passed`.
- Exit 0 only if all non-skipped criteria pass, else exit 1.
- Zero external deps; Node 23 globals (fetch/child_process/test/fs).
- Always cleans up temp files; uses isolated temp dirs for build artifacts.
</content>
</invoke>
