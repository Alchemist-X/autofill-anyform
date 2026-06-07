# AutoFill AnyForm

A Manifest V3 Chrome extension that fills **any** web form from your saved personal profile using field heuristics, with a fully-implemented optional LLM second-pass for unmatched fields. **All data stays on your machine** — nothing is ever sent to a remote server unless you explicitly configure and enable LLM mode.

---

## What's new in v2

- **Multiple profiles** — create "Personal", "Work", or any number of profiles and switch between them in the popup.
- **Per-site default profile** — after filling, pin a profile to a domain so it's auto-selected next time.
- **LLM second pass actually applied** — unmatched fields are sent to your configured LLM; the resulting mappings are immediately applied to the page.
- **Keyboard shortcut** — `Alt+Shift+F` fills the active page without opening the popup.
- **More field types** — `<select>` (text/value matching), radio groups, checkboxes (boolean from profile), date inputs, textareas.
- **Confidence scores** — each heuristic match carries a confidence value; the popup reports filled / skipped / needs-LLM counts with colored chips.
- **Highlight unmatched fields** — toggle to paint unmatched fields amber so you can see what the LLM could help with.
- **Import / Export profile** — download a profile as JSON or upload one from disk in Options.
- **Dark mode** — automatic (respects `prefers-color-scheme`) with a manual toggle in both popup and Options.
- **Polished design system** — consistent accent color, spacing, rounded controls, and dark-mode tokens across popup and options.

---

## How to load the extension (Chrome)

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `autofill-anyform/` folder — the one containing `manifest.json`.
5. The icon appears in your toolbar. Click it to open the popup.

To reload after editing source files: click the refresh icon on the extension card in `chrome://extensions/`.

---

## How to set up your profile

1. Click the extension icon → **Options & Profiles** (or right-click the icon → *Options*).
2. Under **Profiles**, create a new profile or use the default "Personal" one.
3. Fill in **Identity**, **Address**, and **Work** fields as desired.
4. Add **Custom Fields** for anything not covered (e.g. `Username → janesmith42`).
5. Click **Save profile**.

Tip: create a "Work" profile with your company address and switch to it from the popup's profile selector.

---

## How the heuristic works

Each form field gets a descriptor string built from its `autocomplete`, `name`, `id`, `placeholder`, `aria-label`, and label text. That string is scored against a keyword map:

| Profile key  | Matched patterns (examples)                        |
|--------------|----------------------------------------------------|
| firstName    | first name, fname, given name, forename            |
| lastName     | last name, lname, surname, family name             |
| fullName     | full name, your name, name                         |
| email        | email, e-mail                                      |
| phone        | phone, tel, mobile, cell                           |
| address1     | address, street, address line 1, line 1            |
| address2     | apt, suite, unit, address line 2                   |
| city         | city, town, locality                               |
| state        | state, region, province, county                    |
| postalCode   | zip, postal, postcode, pin code                    |
| country      | country, nation                                    |
| company      | company, organization, employer, firm              |
| jobTitle     | job title, title, position, role, occupation       |
| website      | website, url, homepage, site                       |
| birthDate    | birth date, dob, date of birth, birthday           |

The `autocomplete` attribute is checked first — when present and recognized, it wins immediately (confidence = 1.0). Custom fields are matched by their key name appearing in the field descriptor.

---

## Optional LLM mapping

Fields the heuristic cannot match (unusual labels, non-English forms, etc.) can be routed to an LLM:

1. In **Options → LLM**, enter your API endpoint (default: `https://api.openai.com/v1/chat/completions`), model (default: `gpt-4o-mini`), and API key.
2. In the popup, enable **"LLM for ambiguous fields"**.
3. Click **Fill this page** — unmatched field descriptors are sent to the LLM, which returns a mapping to profile keys. Those fields are then filled immediately in the page.

The LLM prompt sends only field metadata (label text, name, placeholder) — **no page content or form values** are transmitted.

---

## Keyboard shortcut

Press **`Alt+Shift+F`** on any page to trigger a fill using your active (or site-default) profile without opening the popup. You can change the shortcut at `chrome://extensions/shortcuts`.

---

## Per-site default profile

After filling a page, a **"Use this profile for this site"** link appears in the result summary. Click it to remember the chosen profile for that domain. The popup shows a badge when a site default is active, with a `×` to clear it.

---

## Import / Export

In **Options → Profiles**:
- **Export profile** — downloads the current profile as a `.json` file.
- **Import profile** — uploads a `.json` file and adds it as a new profile.

The JSON format is human-readable and can be edited with any text editor.

---

## Privacy

- Your profile and API key are stored exclusively in `chrome.storage.local` — local to your browser profile, never synced or sent to any remote server by this extension.
- LLM calls are only made when you have explicitly configured an endpoint + key **and** enabled the toggle in the popup.
- No analytics, no tracking, no remote code.

---

## Manual test steps

1. Load the extension from `autofill-anyform/` via **Load unpacked**.
2. Go to **Options**, create a profile, fill in at least: first name, last name, email, phone, address, city, state, zip, country, company, job title, birthdate. Save.
3. Open `test/sample-form.html` in Chrome (File → Open File, or drag and drop).
4. Click the extension icon → **Fill this page**. Verify:
   - Autocomplete-attribute fields fill correctly (Section 1).
   - Label-heuristic fields fill correctly (Section 2).
   - aria-label / placeholder-only fields fill (Section 3).
   - `<select>` dropdowns for Country and State update (Section 4).
   - Date of Birth inputs populate with the ISO date (Section 7).
   - Textareas fill (Section 8 — "Full Address" should fill from `address1`).
   - Filled fields flash blue briefly.
5. Enable **"Highlight unmatched fields"** in the popup and re-fill — the bio textarea (unmatched) should flash amber.
6. Test **keyboard shortcut**: press `Alt+Shift+F` on the sample form without opening the popup. Fields should fill.
7. Test **multi-profile**: create a second profile in Options with different values. Switch to it in the popup selector, re-fill, verify the new values appear.
8. Test **import/export**: export a profile, edit the JSON, re-import it.
9. Test **dark mode**: click the moon/sun icon in the popup or choose a theme in Options → Appearance.
10. **(LLM, optional)**: configure an OpenAI-compatible key in Options → LLM, enable the toggle, and fill — unmatched fields (e.g. bio) should be filled by the LLM.

---

## File structure

```
autofill-anyform/
├── manifest.json               MV3 manifest — v2.0.0, adds "commands"
├── background/
│   └── service-worker.js       Message router, LLM fetch + apply, keyboard command
├── content/
│   └── content.js              Heuristic matcher, field filler, LLM mapping applier
├── popup/
│   ├── popup.html
│   ├── popup.css               Design tokens, dark mode, polished UI
│   └── popup.js                Profile selector, site default, toggles, result chips
├── options/
│   ├── options.html            Sidebar layout, all sections
│   ├── options.css             Sidebar + dark mode design system
│   └── options.js              Multi-profile CRUD, import/export, theme, LLM config
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── test/
│   └── sample-form.html        Covers all field types: text, select, radio, checkbox, date, textarea
├── .gitignore
├── LICENSE
└── README.md
```

---

## Limitations

- **JavaScript-gated forms**: some SPAs render fields after heavy JS execution. If no fields are found, try filling again after the page fully loads.
- **Shadow DOM**: fields inside closed shadow roots are not reachable via `querySelectorAll`.
- **Multi-step wizards**: only the currently visible fields are filled. Click "Fill this page" again on each step.
- **LLM latency**: with LLM mode on, there will be a brief pause while the API responds.
- **Keyboard shortcut conflict**: if `Alt+Shift+F` is taken by another extension, change it at `chrome://extensions/shortcuts`.

---

## License

MIT © 2026 Alchemist-X
