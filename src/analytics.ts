/**
 * Thin GA4 wrapper. The measurement ID comes from the build environment
 * (VITE_GA_MEASUREMENT_ID); without it every call is a no-op. No source code,
 * project names or project ids are sent.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const measurementId = (import.meta.env.VITE_GA_MEASUREMENT_ID ?? '').trim();
let enabled = false;

export function initAnalytics(): void {
  if (!measurementId || enabled || typeof window === 'undefined') return;
  enabled = true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // the standard gtag queue accepts array-like argument objects
    window.dataLayer!.push(arguments);
  };

  window.gtag('js', new Date());
  window.gtag('config', measurementId, { send_page_view: false });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);
}

export function track(event: string, params: Record<string, unknown> = {}): void {
  if (!enabled || typeof window === 'undefined' || typeof window.gtag !== 'function') return;
  window.gtag('event', event, params);
}

export type Surface = 'landing' | 'editor';

/** Hash routes contain project ids; send a sanitised location instead. */
export function trackPageView(surface: Surface): void {
  if (!enabled || typeof window === 'undefined' || typeof window.gtag !== 'function') return;
  const base = import.meta.env.BASE_URL || '/';
  const route = surface === 'editor' ? '#/project' : '#/';
  window.gtag('event', 'page_view', {
    page_location: `${window.location.origin}${base}${route}`,
    page_path: `${base}${route}`,
    page_title: surface === 'editor' ? 'paraplot — editor' : 'paraplot — projects',
    surface,
  });
}
