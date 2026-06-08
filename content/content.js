/**
 * AutoFill AnyForm — Content script bootstrap (classic script).
 *
 * MV3 declarative content scripts are classic scripts and cannot use static
 * `import`. So this thin bootstrap dynamically imports the ES module that holds
 * all DOM logic (content/main.mjs), which in turn statically imports the pure,
 * unit-tested matcher / field-helper / LLM-apply modules. The module files are
 * declared in `web_accessible_resources` so chrome.runtime.getURL resolves them.
 */

'use strict';

(async () => {
  try {
    const url = chrome.runtime.getURL('content/main.mjs');
    const mod = await import(url);
    if (typeof mod.init === 'function') {
      mod.init();
    } else {
      console.error('AutoFill AnyForm: content/main.mjs did not export init()');
    }
  } catch (err) {
    console.error('AutoFill AnyForm: failed to load content module:', err);
  }
})();
