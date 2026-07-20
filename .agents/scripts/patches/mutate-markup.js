
/**
 * Build a browser-side script that applies DOM attribute mutations on DOMContentLoaded.
 * The returned string is designed to be passed to `page.evaluateOnNewDocument(...)`.
 * Empty-string values result in `setAttribute(key, '')` (e.g. `defer=""`).
 *
 * @param {Array<{selector: string, attrs: Object<string,string>}>} mutations
 * @returns {string} JS source
 */
function buildMarkupMutationScript(mutations) {
  const safe = Array.isArray(mutations) ? mutations : [];
  const json = JSON.stringify(safe);
  return `(function(){
  var mutations = ${json};
  if (!Array.isArray(mutations) || mutations.length === 0) return;
  function apply() {
    try {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (!m || !m.selector || !m.attrs) continue;
        var nodes;
        try { nodes = document.querySelectorAll(m.selector); } catch (e) { continue; }
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          var keys = Object.keys(m.attrs);
          for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            var val = m.attrs[key];
            try {
              if (val === null || val === undefined) {
                el.removeAttribute(key);
              } else {
                el.setAttribute(key, String(val));
              }
            } catch (e) { /* ignore invalid attr */ }
          }
        }
      }
    } catch (e) { /* noop */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
})();`;
}

export { buildMarkupMutationScript };
