
/**
 * Convert a glob-style pattern (with `*` wildcards) to a RegExp.
 * Escapes all regex metacharacters except `*`, which becomes `.*`.
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * Build a URL-blocking predicate from an array of glob patterns.
 * @param {string[]} patterns
 * @returns {(url: string) => boolean}
 */
function buildBlockPredicate(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return () => false;
  }
  const regexes = patterns.map(globToRegex);
  return (url) => {
    if (typeof url !== 'string') return false;
    for (const re of regexes) {
      if (re.test(url)) return true;
    }
    return false;
  };
}

export { buildBlockPredicate, globToRegex };
