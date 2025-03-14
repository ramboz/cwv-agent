export default [
  (await import('./100kb.js')).default,
  (await import('./laf.js')).default,
  (await import('./tbt.js')).default,
  (await import('./cls.js')).default,
  (await import('./lcp.js')).default,
  (await import('./loading-sequence-fonts.js')).default,
  (await import('./loading-sequence-size.js')).default,
];