export default [
  (await import('./100kb.js')).default,
  (await import('./laf.js')).default,
  (await import('./tbt.js')).default,
];