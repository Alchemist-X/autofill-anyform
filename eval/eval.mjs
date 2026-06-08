#!/usr/bin/env node
/**
 * AutoFill AnyForm — strict pass/fail eval harness.
 *
 * Run from repo root:  node eval/eval.mjs
 *
 * Zero external deps. Node 23 globals only (fs, path, url, child_process, os).
 * Prints "PASS Cx: ..." / "FAIL Cx: <why>" per criterion, ends with
 * "RESULT: X/Y passed", exits 0 iff all non-skipped criteria pass, else 1.
 *
 * The extension cannot run in a browser here, so correctness is asserted against
 * a PURE importable ESM matcher module the content script must import.
 *
 * Cleans up all temp files / dirs it creates.
 */

import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, extname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // repo root (extension dir)
const FIX = join(__dirname, 'fixtures');

// ── result bookkeeping ──────────────────────────────────────────────────────
const results = []; // { id, ok, msg, skipped }
const cleanups = [];

function record(id, ok, msg) {
  results.push({ id, ok, skipped: false });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${msg}`);
}
function skip(id, msg) {
  results.push({ id, ok: true, skipped: true });
  console.log(`SKIP ${id}: ${msg}`);
}
function cleanup() {
  for (const fn of cleanups.reverse()) {
    try { fn(); } catch { /* ignore */ }
  }
}

// ── small fs helpers ────────────────────────────────────────────────────────
function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'eval') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve & dynamically import the pure matcher module.
 * The criteria name content/match.mjs; accept a few plausible locations but the
 * EXPORTED contract (matchField) is what is strictly required.
 */
async function importModule(candidatePaths) {
  for (const rel of candidatePaths) {
    const abs = join(ROOT, rel);
    if (existsSync(abs)) {
      const mod = await import(pathToFileURL(abs).href + `?t=${Date.now()}`);
      return { mod, path: rel };
    }
  }
  return null;
}

/** Find an exported function by trying a list of names, else scan for any fn. */
function pickFn(mod, names) {
  for (const n of names) {
    if (typeof mod?.[n] === 'function') return { fn: mod[n], name: n };
  }
  return null;
}

// Normalize a {key, confidence} return into a uniform shape.
function normMatch(r) {
  if (r === null || r === undefined) return { key: null, confidence: 0 };
  if (typeof r === 'string') return { key: r, confidence: 1 };
  const key = r.key ?? r.profileKey ?? null;
  const confidence = typeof r.confidence === 'number' ? r.confidence : (key ? 1 : 0);
  return { key, confidence };
}

// Fill threshold below which a match is "low confidence" (not a confident fill).
// Mirrors the extension's CONFIDENCE_THRESHOLD = 0.4.
const LOW_CONF_MAX = 0.4;

// ════════════════════════════════════════════════════════════════════════════
// C1 — lint / manifest
// ════════════════════════════════════════════════════════════════════════════
function runC1() {
  const problems = [];

  // node --check on every .js / .mjs (excluding eval/, node_modules, .git)
  const scripts = walk(ROOT).filter(f => ['.js', '.mjs'].includes(extname(f)));
  for (const f of scripts) {
    const res = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (res.status !== 0) {
      problems.push(`node --check failed on ${relative(ROOT, f)}: ${(res.stderr || '').trim().split('\n')[0]}`);
    }
  }

  // manifest parses as valid MV3
  const manifestPath = join(ROOT, 'manifest.json');
  let manifest = null;
  if (!existsSync(manifestPath)) {
    problems.push('manifest.json missing');
  } else {
    try {
      manifest = readJson(manifestPath);
    } catch (e) {
      problems.push(`manifest.json invalid JSON: ${e.message}`);
    }
  }
  if (manifest) {
    if (manifest.manifest_version !== 3) problems.push(`manifest_version is ${manifest.manifest_version}, expected 3`);
    if (!manifest.name) problems.push('manifest missing name');
    if (!manifest.version) problems.push('manifest missing version');
    if (!manifest.action && !manifest.background) problems.push('manifest missing action/background');

    // every referenced file exists
    const refs = [];
    if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
    if (manifest.options_page) refs.push(manifest.options_page);
    if (manifest.options_ui?.page) refs.push(manifest.options_ui.page);
    if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
    for (const cs of manifest.content_scripts ?? []) {
      for (const j of cs.js ?? []) refs.push(j);
      for (const c of cs.css ?? []) refs.push(c);
    }
    for (const war of manifest.web_accessible_resources ?? []) {
      for (const r of war.resources ?? []) refs.push(r);
    }
    const iconMaps = [manifest.icons, manifest.action?.default_icon].filter(Boolean);
    for (const im of iconMaps) for (const v of Object.values(im)) refs.push(v);

    for (const ref of refs) {
      if (!existsSync(join(ROOT, ref))) problems.push(`manifest references missing file: ${ref}`);
    }
  }

  // 3 icons exist
  for (const icon of ['icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png']) {
    if (!existsSync(join(ROOT, icon))) problems.push(`missing icon: ${icon}`);
  }

  if (problems.length === 0) {
    record('C1', true, `node --check clean on ${scripts.length} scripts; manifest valid MV3; all referenced files + 3 icons exist`);
  } else {
    record('C1', false, problems.join(' | '));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// C2 / C3 / C4 — pure matcher correctness, word-boundary, confidence
// ════════════════════════════════════════════════════════════════════════════
async function loadMatcher() {
  const found = await importModule([
    'content/match.mjs',
    'content/matcher.mjs',
    'content/match.js',
    'lib/match.mjs',
    'src/match.mjs',
  ]);
  if (!found) return { err: 'no importable matcher module (expected content/match.mjs)' };
  const picked = pickFn(found.mod, ['matchField', 'match', 'resolveProfileKey']);
  if (!picked) return { err: `module ${found.path} exports no matchField(descriptor, profile) function` };
  return { matchField: picked.fn, path: found.path, name: picked.name };
}

// Build descriptor objects the way matchField is expected to receive them.
// We pass both a rich descriptor (label/name/id) and rely on the matcher to
// derive tokens. matchField MUST accept a descriptor object.
function toDescriptor(c) {
  return {
    label: c.label ?? '',
    labelText: c.label ?? '',
    name: c.name ?? '',
    id: c.id ?? c.name ?? '',
    placeholder: '',
    ariaLabel: '',
    autocomplete: '',
    type: c.type ?? 'text',
  };
}

async function runMatcherCriteria() {
  const m = await loadMatcher();
  if (m.err) {
    record('C2', false, m.err);
    record('C3', false, 'matcher module not importable (see C2)');
    record('C4', false, 'matcher module not importable (see C2)');
    return;
  }

  const fixtures = readJson(join(FIX, 'descriptors.json'));
  const profile = fixtures.profile;
  const matchField = m.matchField;

  // helper to call & normalize
  const call = (c) => normMatch(matchField(toDescriptor(c), profile));

  // ── C2: must-map correctness + must-not-mismap ──
  const c2problems = [];
  for (const c of fixtures.mustMap) {
    let r;
    try { r = call(c); } catch (e) { c2problems.push(`"${c.label}" threw: ${e.message}`); continue; }
    if (r.key !== c.expect) {
      c2problems.push(`"${c.label}" -> ${r.key} (expected ${c.expect})`);
    }
    if (c.notKey) {
      for (const bad of c.notKey) {
        if (r.key === bad) c2problems.push(`"${c.label}" mis-mapped to ${bad}`);
      }
    }
  }
  for (const c of fixtures.mustNotMisMap) {
    let r;
    try { r = call(c); } catch (e) { c2problems.push(`"${c.label}" threw: ${e.message}`); continue; }
    for (const bad of c.notKey ?? []) {
      if (r.key === bad) {
        // For mustBeLowOrNull cases, mapping to bad key with high confidence is a fail.
        if (c.mustBeLowOrNull) {
          if (r.confidence > LOW_CONF_MAX) {
            c2problems.push(`"${c.label}" -> ${bad} @conf ${r.confidence} (must be null or low-confidence)`);
          }
        } else {
          c2problems.push(`"${c.label}" mis-mapped to ${bad}`);
        }
      }
    }
  }
  if (c2problems.length === 0) {
    record('C2', true, `matcher maps all required descriptors correctly and avoids the mis-fill bug (module: ${m.path})`);
  } else {
    record('C2', false, c2problems.join(' | '));
  }

  // ── C3: word-boundary / specificity ──
  const c3problems = [];
  const companyCase = fixtures.mustMap.find(c => c.label === 'Company Name');
  if (companyCase) {
    const r = call(companyCase);
    if (r.key !== 'company') c3problems.push(`"Company Name" -> ${r.key} (generic "name" rule leaked; expected company)`);
  }
  for (const label of ['Username', 'Cardholder Name']) {
    const c = [...fixtures.mustMap, ...fixtures.mustNotMisMap].find(x => x.label === label);
    if (c) {
      const r = call(c);
      if (r.key === 'fullName') c3problems.push(`"${label}" -> fullName (generic "name" greedily matched)`);
      if (label === 'Cardholder Name' && (r.key === 'firstName')) c3problems.push(`"Cardholder Name" -> firstName`);
    }
  }
  if (c3problems.length === 0) {
    record('C3', true, 'generic "name" rule does not greedily match Company Name / Username / Cardholder Name (word-boundary/specificity ok)');
  } else {
    record('C3', false, c3problems.join(' | '));
  }

  // ── C4: confidence ──
  const c4problems = [];
  // high-confidence clear field
  for (const c of fixtures.highConfidence) {
    const r = call(c);
    if (typeof r.confidence !== 'number') c4problems.push(`"${c.label}" returned non-numeric confidence`);
    else if (r.confidence <= LOW_CONF_MAX) c4problems.push(`"${c.label}" should be HIGH confidence, got ${r.confidence}`);
  }
  // ambiguous -> null or low confidence
  for (const c of fixtures.ambiguous) {
    const r = call(c);
    const lowOrNull = r.key === null || r.confidence <= LOW_CONF_MAX;
    if (!lowOrNull) {
      c4problems.push(`"${c.label}" -> ${r.key} @conf ${r.confidence} (ambiguous must be null/low-confidence)`);
    }
  }
  if (c4problems.length === 0) {
    record('C4', true, 'matchField returns numeric confidence; clear fields high, ambiguous/no-match null or low-confidence');
  } else {
    record('C4', false, c4problems.join(' | '));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// C5 — pure field-type helpers (select / checkbox / radio / date)
// ════════════════════════════════════════════════════════════════════════════
async function runC5() {
  const found = await importModule([
    'content/fields.mjs',
    'content/helpers.mjs',
    'content/field-helpers.mjs',
    'content/setters.mjs',
    'lib/fields.mjs',
  ]);
  if (!found) {
    record('C5', false, 'no importable field-type helpers module (expected e.g. content/fields.mjs)');
    return;
  }
  const mod = found.mod;
  const problems = [];

  // select helper: match option by text/value -> chosen value
  const selectFn = pickFn(mod, ['matchSelectOption', 'selectOption', 'chooseOption', 'matchOption', 'resolveSelectValue']);
  if (!selectFn) {
    problems.push('no select helper export (matchSelectOption/selectOption)');
  } else {
    const options = [
      { value: 'us', text: 'United States' },
      { value: 'ca', text: 'Canada' },
      { value: 'il', text: 'Illinois' },
    ];
    const got1 = selectFn.fn('United States', options);
    const got2 = selectFn.fn('ca', options);
    const got3 = selectFn.fn('Nowhere', options);
    if (got1 !== 'us') problems.push(`select by text "United States" -> ${JSON.stringify(got1)} (expected "us")`);
    if (got2 !== 'ca') problems.push(`select by value "ca" -> ${JSON.stringify(got2)} (expected "ca")`);
    if (got3 !== null && got3 !== undefined) problems.push(`select no-match -> ${JSON.stringify(got3)} (expected null)`);
  }

  // checkbox helper: coerce to boolean
  const cbFn = pickFn(mod, ['toCheckboxState', 'checkboxBool', 'toBoolean', 'coerceBoolean', 'parseBoolean']);
  if (!cbFn) {
    problems.push('no checkbox helper export (toCheckboxState/toBoolean)');
  } else {
    const truthy = ['true', 'yes', '1', 'on', true].map(v => cbFn.fn(v));
    const falsy = ['false', 'no', '0', 'off', '', false].map(v => cbFn.fn(v));
    if (!truthy.every(v => v === true)) problems.push(`checkbox truthy coercion failed: ${JSON.stringify(truthy)}`);
    if (!falsy.every(v => v === false)) problems.push(`checkbox falsy coercion failed: ${JSON.stringify(falsy)}`);
  }

  // radio helper: choose value from group by value/label
  const radioFn = pickFn(mod, ['matchRadioValue', 'chooseRadio', 'matchRadio', 'resolveRadioValue']);
  if (!radioFn) {
    problems.push('no radio helper export (matchRadioValue/chooseRadio)');
  } else {
    const group = [
      { value: 'm', label: 'Male' },
      { value: 'f', label: 'Female' },
    ];
    const r1 = radioFn.fn('Female', group);
    const r2 = radioFn.fn('m', group);
    const r3 = radioFn.fn('x', group);
    if (r1 !== 'f') problems.push(`radio by label "Female" -> ${JSON.stringify(r1)} (expected "f")`);
    if (r2 !== 'm') problems.push(`radio by value "m" -> ${JSON.stringify(r2)} (expected "m")`);
    if (r3 !== null && r3 !== undefined) problems.push(`radio no-match -> ${JSON.stringify(r3)} (expected null)`);
  }

  // date helper: normalize to ISO YYYY-MM-DD
  const dateFn = pickFn(mod, ['toIsoDate', 'normalizeDate', 'toDateString', 'formatDate', 'parseDate']);
  if (!dateFn) {
    problems.push('no date helper export (toIsoDate/normalizeDate)');
  } else {
    const d1 = dateFn.fn('1990-05-15');
    if (d1 !== '1990-05-15') problems.push(`date passthrough ISO -> ${JSON.stringify(d1)} (expected "1990-05-15")`);
    const d2 = dateFn.fn('May 15, 1990');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d2 ?? ''))) {
      problems.push(`date "May 15, 1990" -> ${JSON.stringify(d2)} (expected ISO YYYY-MM-DD)`);
    } else if (d2 !== '1990-05-15') {
      problems.push(`date "May 15, 1990" -> ${JSON.stringify(d2)} (expected "1990-05-15")`);
    }
  }

  if (problems.length === 0) {
    record('C5', true, `pure field helpers (select/checkbox/radio/date) importable and correct (module: ${found.path})`);
  } else {
    record('C5', false, problems.join(' | '));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// C6 — LLM apply path (pure, importable, mock mapping)
// ════════════════════════════════════════════════════════════════════════════
async function runC6() {
  const found = await importModule([
    'content/apply-llm.mjs',
    'content/llm-apply.mjs',
    'content/apply.mjs',
    'background/apply-llm.mjs',
    'lib/apply-llm.mjs',
    'content/match.mjs', // may co-locate
  ]);
  if (!found) {
    record('C6', false, 'no importable LLM-apply module (expected e.g. content/apply-llm.mjs)');
    return;
  }
  const applyFn = pickFn(found.mod, [
    'applyLlmMapping', 'applyLlmMappings', 'applyMapping', 'resolveMappingValues', 'computeLlmFills', 'buildLlmFills',
  ]);
  if (!applyFn) {
    record('C6', false, `module ${found.path} exports no LLM-apply function (applyLlmMapping/resolveMappingValues)`);
    return;
  }

  const fx = readJson(join(FIX, 'llm-mapping.json'));
  const problems = [];

  let out;
  try {
    out = applyFn.fn(fx.mappings, fx.fieldDescriptors, fx.profile);
  } catch (e) {
    record('C6', false, `LLM-apply threw: ${e.message}`);
    return;
  }

  // Accept either: a map {index -> value}, or an array of {index, value} / {key, value}.
  const valueByIndex = {};
  if (Array.isArray(out)) {
    for (const item of out) {
      const idx = String(item.index ?? item.i ?? item.fieldIndex ?? '');
      const val = item.value ?? item.val;
      if (idx !== '') valueByIndex[idx] = val;
    }
  } else if (out && typeof out === 'object') {
    // could be {applied, values} or a plain index->value map
    const src = (out.values && typeof out.values === 'object') ? out.values : out;
    for (const [k, v] of Object.entries(src)) {
      if (/^\d+$/.test(k)) valueByIndex[k] = (v && typeof v === 'object' && 'value' in v) ? v.value : v;
    }
  } else {
    problems.push(`LLM-apply returned unsupported shape: ${typeof out}`);
  }

  for (const [idx, expected] of Object.entries(fx.expectValues)) {
    if (valueByIndex[idx] !== expected) {
      problems.push(`index ${idx} -> ${JSON.stringify(valueByIndex[idx])} (expected ${JSON.stringify(expected)})`);
    }
  }
  for (const idx of fx.expectSkippedIndices) {
    if (idx in valueByIndex && valueByIndex[idx] !== null && valueByIndex[idx] !== undefined && valueByIndex[idx] !== '') {
      problems.push(`index ${idx} should be skipped (null mapping) but got ${JSON.stringify(valueByIndex[idx])}`);
    }
  }

  if (problems.length === 0) {
    record('C6', true, `LLM-apply resolves mock mapping to correct per-field values, skips nulls (module: ${found.path})`);
  } else {
    record('C6', false, problems.join(' | '));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// C7 — node --test (>= 6 tests, all pass)
// ════════════════════════════════════════════════════════════════════════════
function runC7() {
  // Discover test files (test/*.test.* or test/*.mjs that look like tests).
  const testDir = join(ROOT, 'test');
  if (!existsSync(testDir)) {
    record('C7', false, 'no test/ directory');
    return;
  }
  const testFiles = walk(testDir).filter(f =>
    /\.(test|spec)\.(mjs|js)$/.test(f) || /test.*\.(mjs|js)$/.test(f.split('/').pop())
  ).filter(f => ['.mjs', '.js'].includes(extname(f)));

  if (testFiles.length === 0) {
    record('C7', false, 'no test files found under test/ (expected *.test.mjs using node:test)');
    return;
  }

  // Force the TAP reporter for deterministic, parseable output (Node's default
  // under a pipe is the spec reporter, which uses "ℹ tests N" lines).
  const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
    cwd: ROOT, encoding: 'utf8',
  });
  const out = (res.stdout || '') + (res.stderr || '');

  // Parse summary. TAP: "# tests N" / "# pass N" / "# fail N".
  // Spec fallback: "ℹ tests N" / "ℹ pass N" / "ℹ fail N".
  const testsM = out.match(/^[#ℹ\s]*\s*tests\s+(\d+)/m);
  const passM = out.match(/^[#ℹ\s]*\s*pass\s+(\d+)/m);
  const failM = out.match(/^[#ℹ\s]*\s*fail\s+(\d+)/m);
  const total = testsM ? parseInt(testsM[1], 10) : null;
  const passed = passM ? parseInt(passM[1], 10) : null;
  const failed = failM ? parseInt(failM[1], 10) : null;

  if (res.status !== 0) {
    record('C7', false, `node --test exited ${res.status} (tests=${total} pass=${passed} fail=${failed}); first line: ${(out.trim().split('\n').find(l => /not ok|Error/.test(l)) || '').slice(0, 160)}`);
    return;
  }
  if (total === null) {
    record('C7', false, `could not parse node --test output (TAP summary missing)`);
    return;
  }
  if ((failed ?? 0) > 0) {
    record('C7', false, `${failed} test(s) failed`);
    return;
  }
  if (total < 6) {
    record('C7', false, `only ${total} test(s) found, need >= 6`);
    return;
  }
  record('C7', true, `node --test: ${total} tests, ${passed} passed, 0 failed (>= 6)`);
}

// ════════════════════════════════════════════════════════════════════════════
// C8 — packaging / docs (README load-unpacked + build:zip script -> loadable zip)
// ════════════════════════════════════════════════════════════════════════════
function runC8() {
  const problems = [];

  // README load-unpacked steps
  const readmePath = join(ROOT, 'README.md');
  if (!existsSync(readmePath)) {
    problems.push('README.md missing');
  } else {
    const readme = readFileSync(readmePath, 'utf8').toLowerCase();
    const needles = ['chrome://extensions', 'developer mode', 'load unpacked'];
    const missing = needles.filter(n => !readme.includes(n));
    if (missing.length) problems.push(`README missing load-unpacked details: ${missing.join(', ')}`);
    if (!readme.includes('manifest.json')) problems.push('README does not mention selecting the folder containing manifest.json');
    if (!/build:zip|build-zip|npm run build/.test(readme)) problems.push('README does not document the build:zip / zip packaging step');
  }

  // package.json with build:zip script
  const pkgPath = join(ROOT, 'package.json');
  if (!existsSync(pkgPath)) {
    problems.push('no package.json (needed for npm build:zip script)');
    record('C8', false, problems.join(' | '));
    return;
  }
  let pkg;
  try { pkg = readJson(pkgPath); } catch (e) { problems.push(`package.json invalid JSON: ${e.message}`); record('C8', false, problems.join(' | ')); return; }

  // no external runtime/dev deps required (Node-only)
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (Object.keys(deps).length > 0) {
    problems.push(`build must use NO external deps; package.json declares: ${Object.keys(deps).join(', ')}`);
  }

  const script = pkg.scripts?.['build:zip'];
  if (!script) {
    problems.push('no "build:zip" npm script');
    record('C8', false, problems.join(' | '));
    return;
  }

  // Run the build:zip script in an isolated env; capture produced .zip.
  const before = new Set(existsSync(ROOT) ? readdirSync(ROOT) : []);
  // Also check a conventional dist/ output dir.
  let runOk = true, runErr = '';
  const res = spawnSync('npm', ['run', 'build:zip'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, npm_config_offline: 'true' },
  });
  if (res.error || res.status !== 0) {
    runOk = false;
    runErr = (res.error?.message || '') + ' ' + (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' / ');
  }

  if (!runOk) {
    problems.push(`build:zip failed: ${runErr.slice(0, 200)}`);
    record('C8', false, problems.join(' | '));
    return;
  }

  // Locate produced zip: new top-level zip, or any zip in dist/.
  const candidates = [];
  for (const name of readdirSync(ROOT)) {
    if (name.endsWith('.zip') && !before.has(name)) candidates.push(join(ROOT, name));
    if (name.endsWith('.zip') && before.has(name)) candidates.push(join(ROOT, name)); // overwritten
  }
  const distDir = join(ROOT, 'dist');
  if (existsSync(distDir)) {
    for (const name of readdirSync(distDir)) {
      if (name.endsWith('.zip')) candidates.push(join(distDir, name));
    }
  }
  // dedup, keep most recent
  const uniq = [...new Set(candidates)].filter(p => existsSync(p));
  if (uniq.length === 0) {
    problems.push('build:zip ran but no .zip was produced (checked repo root and dist/)');
    record('C8', false, problems.join(' | '));
    return;
  }
  uniq.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const zipPath = uniq[0];
  // schedule cleanup of produced zip + dist dir if we want isolation
  cleanups.push(() => { try { rmSync(zipPath, { force: true }); } catch {} });

  // Verify the zip contains manifest.json (loadable extension) using `unzip -l`.
  let contents = '';
  try {
    contents = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  } catch (e) {
    // Fallback: read central-directory file names from raw bytes.
    try {
      const buf = readFileSync(zipPath);
      contents = buf.toString('latin1');
    } catch {
      problems.push(`could not inspect zip ${relative(ROOT, zipPath)}: ${e.message}`);
    }
  }
  if (!/manifest\.json/.test(contents)) {
    problems.push(`produced zip ${relative(ROOT, zipPath)} does not contain manifest.json`);
  }

  if (problems.length === 0) {
    record('C8', true, `README has load-unpacked steps; build:zip (no deps) produced loadable ${relative(ROOT, zipPath)} containing manifest.json`);
  } else {
    record('C8', false, problems.join(' | '));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  try {
    runC1();
    await runMatcherCriteria(); // C2, C3, C4
    await runC5();
    await runC6();
    runC7();
    runC8();
  } finally {
    cleanup();
  }

  const counted = results.filter(r => !r.skipped);
  const passed = counted.filter(r => r.ok).length;
  const total = counted.length;
  console.log(`\nRESULT: ${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch(err => {
  console.error('HARNESS ERROR:', err);
  cleanup();
  console.log(`\nRESULT: 0/8 passed`);
  process.exit(1);
});
