export default [
  (await import('./100kb.js')).default,
  (await import('./laf.js')).default,
  (await import('./tbt.js')).default,
  (await import('./cls.js')).default,
  (await import('./lcp.js')).default,
  (await import('./loading-sequence-fonts.js')).default,
  (await import('./loading-sequence-size.js')).default,
  (await import('./loading-sequence-3rdparty.js')).default,
  (await import('./loading-sequence-media.js')).default,
  (await import('./images-loading.js')).default,
  (await import('./http-version.js')).default,
  (await import('./loading-sequence-blocking.js')).default,
];