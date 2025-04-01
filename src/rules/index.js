import kb100 from './critical-path/kb100.js';
import loaf from './main-thread/loaf.js';
import tbt from './main-thread/tbt.js';
import cls from './cls/cls.js';
import lcp from './critical-path/lcp.js';
import loadingSequenceFonts from './critical-path/fonts.js';
import loadingSequenceSize from './critical-path/size.js';
import loadingSequence3rdparty from './critical-path/thirdparty.js';
import loadingSequenceMedia from './critical-path/no-extra-media.js';
import imagesLoading from './critical-path/images-loading.js';
import httpVersion from './ttfb/http-version.js';
import loadingSequenceBlocking from './main-thread/blocking.js';
import noInlineSvg from './critical-path/no-inline-svg.js';
import lazyHeaderFooter from './critical-path/no-header-footer.js';
import fonts from './fonts/fonts.js';

export default [
  kb100,
  loaf,
  tbt,
  cls,
  lcp,
  loadingSequenceFonts,
  loadingSequenceSize,
  loadingSequence3rdparty,
  loadingSequenceMedia,
  imagesLoading,
  httpVersion,
  loadingSequenceBlocking,
  noInlineSvg,
  lazyHeaderFooter,
  fonts,
  // TODO: check redirects on 1st party domain
];