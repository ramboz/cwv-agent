/**
 * Framework-specific optimization patterns for CWV remediation
 * Source: Inspired by Addy Osmani's web-quality-skills (150+ Lighthouse audits)
 * Purpose: Provide framework-native solutions instead of generic advice
 */

export const FRAMEWORK_OPTIMIZATIONS = {
  react: {
    lcp: [
      "Use React.lazy() for code splitting: const Modal = React.lazy(() => import('./Modal'))",
      "Avoid large useEffect chains that block initial render",
      "Move data fetching to server (Next.js getServerSideProps/getStaticProps)",
      "Use <Suspense> to show loading states without blocking LCP element"
    ],
    inp: [
      "Use React.memo() to prevent unnecessary re-renders: const Memo = React.memo(Component)",
      "Use useMemo/useCallback for expensive computations",
      "Use useTransition for non-urgent updates (React 18+): const [isPending, startTransition] = useTransition()",
      "Avoid inline function creation in render: move handlers outside component",
      "Debounce rapid state updates: const debouncedValue = useDeferredValue(value)"
    ],
    cls: [
      "Specify dimensions for dynamic content containers",
      "Use key prop correctly to prevent unexpected re-renders",
      "Avoid conditional rendering that changes layout structure"
    ]
  },

  nextjs: {
    lcp: [
      "Use next/image with priority prop for LCP images: <Image priority src='...' />",
      "Enable ISR (Incremental Static Regeneration): revalidate: 60 in getStaticProps",
      "Use next/dynamic for client-side code splitting: dynamic(() => import('...'))",
      "Optimize fonts with next/font: import { Inter } from 'next/font/google'"
    ],
    inp: [
      "Use Server Components (App Router) to reduce client JS",
      "Add 'use client' only where interactivity is needed",
      "Optimize Route Handlers for fast API responses"
    ],
    cls: [
      "Specify sizes prop in next/image to prevent layout shifts: sizes='(max-width: 768px) 100vw, 50vw'",
      "Use next/font for optimized web fonts with automatic size-adjust",
      "Reserve space for dynamic imports with min-height"
    ]
  },

  vue: {
    lcp: [
      "Use Nuxt's asyncData for SSR data fetching",
      "Lazy-load routes with dynamic imports: () => import('./Page.vue')",
      "Use <NuxtImg> component for optimized images"
    ],
    inp: [
      "Use computed properties instead of methods in templates",
      "Use v-once for static content to skip re-renders",
      "Avoid heavy watchers in created() hook - use computed instead",
      "Use v-memo (Vue 3.2+) for list optimization"
    ],
    cls: [
      "Specify image dimensions in template attributes",
      "Avoid v-if that changes layout - use v-show for visibility toggles"
    ]
  },

  nuxt: {
    lcp: [
      "Use <NuxtImg> and <NuxtPicture> for automatic image optimization",
      "Enable payload extraction: experimental.payloadExtraction in nuxt.config",
      "Use hybrid rendering (SSR + SSG) for optimal performance"
    ],
    inp: [
      "Use Nuxt Auto Imports to reduce bundle size",
      "Lazy-load components with Lazy prefix: <LazyModal />",
      "Use useState for reactive data instead of reactive()"
    ]
  },

  svelte: {
    lcp: [
      "Use SvelteKit's load functions for SSR",
      "Enable SSR in svelte.config.js",
      "Use {#await} for async data loading with placeholders"
    ],
    inp: [
      "Use Svelte's reactive statements efficiently: $: computed = value * 2",
      "Avoid expensive computations in reactive blocks",
      "Use event modifiers for better performance: on:click|once|preventDefault"
    ]
  },

  astro: {
    lcp: [
      "Leverage Astro's partial hydration - only hydrate interactive components",
      "Use client:load directive for critical interactive components",
      "Use client:idle for non-critical interactivity",
      "Optimize with <Image> component from astro:assets"
    ],
    inp: [
      "Minimize client:load usage - prefer client:idle or client:visible",
      "Use View Transitions API (experimental) for smooth navigation"
    ]
  },

  angular: {
    lcp: [
      "Enable SSR with Angular Universal",
      "Use lazy loading routes: loadChildren in router config",
      "Use NgOptimizedImage directive for automatic image optimization"
    ],
    inp: [
      "Use OnPush change detection strategy to reduce checks",
      "Use trackBy in *ngFor to optimize list rendering",
      "Avoid expensive operations in template expressions",
      "Use RxJS debounceTime for input handlers"
    ]
  },

  vanilla: {
    lcp: [
      "Prioritize critical images: <img loading='eager' fetchpriority='high'>",
      "Defer non-critical scripts: <script defer>",
      "Use responsive images: <img srcset> for device-appropriate sizes"
    ],
    inp: [
      "Debounce event handlers manually or with lodash.debounce",
      "Use requestIdleCallback for non-urgent work",
      "Break long tasks with setTimeout(fn, 0) or requestAnimationFrame",
      "Use event delegation for many similar listeners"
    ],
    cls: [
      "Always specify width and height attributes on images",
      "Use aspect-ratio CSS for responsive containers",
      "Reserve space for ads/embeds with min-height",
      "Use font-display: swap with size-adjust in @font-face"
    ]
  }
};

/**
 * Generates framework-specific optimization context for an agent
 * @param {string[]} frameworks - Array of detected frameworks (e.g., ['react', 'nextjs'])
 * @param {string} metric - The CWV metric being optimized ('lcp', 'inp', 'cls')
 * @returns {string} - Formatted context string for agent prompt
 */
export function getFrameworkContext(frameworks = ['vanilla'], metric) {
  if (frameworks.length === 0) frameworks = ['vanilla'];

  return `
## FRAMEWORK-SPECIFIC OPTIMIZATIONS

Detected frameworks: ${frameworks.join(', ')}

${frameworks.map(fw => {
    const patterns = FRAMEWORK_OPTIMIZATIONS[fw]?.[metric];
    if (!patterns || patterns.length === 0) {
      return `### ${fw.toUpperCase()}: No specific patterns for ${metric.toUpperCase()}`;
    }

    return `
### ${fw.toUpperCase()} - ${metric.toUpperCase()} Optimizations:

${patterns.map((tip, i) => `${i + 1}. ${tip}`).join('\n')}
`;
  }).join('\n')}

**CRITICAL:** Prioritize framework-native solutions over generic workarounds.
Framework-specific optimizations are:
- Better tested and maintained by framework authors
- More likely to be future-proof
- Better integrated with framework's build system
- More familiar to developers using that framework
`;
}
