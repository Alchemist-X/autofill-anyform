# AutoFill AnyForm

A Manifest V3 Chrome extension that fills **any** web form from your saved personal profile using field heuristics, with optional LLM mapping for ambiguous fields. **All data stays on your machine** — nothing is sent to any server unless you explicitly configure and enable LLM mode.

---

## What it does

- Scans every `<input>`, `<select>`, and `<textarea>` on the active page.
- Matches each field to a profile value using a **scoring heuristic** that examines:
  - `autocomplete` attribute (highest priority)
  - `name`, `id`, `placeholder`, `aria-label`, and `<label>` text
- Fills matched fields and fires `input`/`change`/`blur` events so React and other frameworks register the change.
- Highlights filled fields briefly in blue.
- Reports a count of filled / skipped / unmatched fields in the popup.
- Optionally routes unmatched fields to an **LLM** (OpenAI-compatible API) for smart mapping — off by default and only triggered when you flip the popup toggle.

---

## How to load the extension (Chrome)

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `autofill-anyform/` folder (the one containing `manifest.json`).
5. The extension icon (blue square) appears in your toolbar.

---

## How to set up your profile

1. Click the extension icon → click **Options / Edit Profile** (or right-click the icon → *Options*).
2. Fill in as many fields as you like — only fields you populate will be used.
3. Add **Custom Fields** for anything not covered (e.g. `Username`, `Twitter handle`).
4. Click **Save profile**.

---

## How the heuristic works

Each form field gets a descriptor string built from its `autocomplete`, `name`, `id`, `placeholder`, `aria-label`, and label text. That string is matched against a keyword map:

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

The `autocomplete` attribute is checked first — when present and recognized (e.g. `given-name`, `postal-code`), it wins immediately.

Custom fields are matched by their exact key name appearing in the field descriptor.

---

## Optional LLM mapping

For fields the heuristic cannot match (unusual labels, non-English forms, etc.):

1. In Options, enter your API endpoint (default: `https://api.openai.com/v1/chat/completions`), model (default: `gpt-4o-mini`), and API key.
2. In the popup, enable **"Use LLM for ambiguous fields"**.
3. Click **Fill this page** — unmatched field descriptors are sent to the LLM, which returns a mapping to profile keys. Those fields are then filled.

The LLM prompt sends only field metadata (label text, name, placeholder etc.) — **no page content or form values** are transmitted.

---

## Privacy

- Your profile and API key are stored exclusively in `chrome.storage.local` — local to your browser profile, never synced or sent to any remote server by this extension.
- LLM calls are only made when you have explicitly configured an endpoint + key **and** enabled the toggle in the popup.
- No analytics, no tracking, no remote code.

---

## How to test with the sample form

1. Open `test/sample-form.html` in Chrome (File → Open File, or drag it in).
2. Click the extension icon → **Fill this page**.
3. Fields should populate and flash blue.

The sample form covers: autocomplete attributes, label-based matching, aria-label matching, placeholder-only fields, `<select>` dropdowns, and a `<textarea>`.

---

## Limitations

- **JavaScript-gated forms**: some SPAs render fields after heavy JS execution. If no fields are found, try clicking "Fill this page" again after the page fully loads.
- **Shadow DOM**: fields inside closed shadow roots are not reachable by standard `querySelectorAll` and will be missed.
- **CAPTCHAs and honeypot fields**: intentionally not filled (they have no meaningful profile mapping).
- **Multi-step wizards**: only the currently visible fields are filled. Click "Fill this page" again on each step.
- **Select matching**: the extension tries to match your profile value against option text and value attributes (case-insensitive substring). If your country/state value doesn't match any option text, the select is left unchanged.
- **LLM latency**: with LLM mode on, there will be a short delay while the API responds. The fill still happens in full when it completes.

---

## File structure

```
autofill-anyform/
├── manifest.json
├── background/
│   └── service-worker.js    # message router + LLM fetch
├── content/
│   └── content.js           # heuristic matcher + field filler
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── test/
│   └── sample-form.html
├── .gitignore
├── LICENSE
└── README.md
```

---

## License

MIT © 2026 Alchemist-X
