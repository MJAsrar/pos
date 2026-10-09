/**
 * The renderer's Content-Security-Policy.
 *
 * A pure function with no imports, so the policy can be asserted in a test. It
 * is in its own module because the two modes genuinely differ and getting that
 * wrong is invisible until someone runs the app: too strict and the dev server
 * will not boot, too loose and the shipped app carries a relaxation it does not
 * need.
 *
 * The page needs no network at all in production — fonts are bundled and data
 * comes over IPC — so everything is locked to 'self'.
 */
export function contentSecurityPolicy(development: boolean): string {
  return [
    "default-src 'self'",
    // React Fast Refresh injects an inline preamble, which only exists while
    // the dev server is running. The shipped app allows no inline script.
    development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    // Vite injects styles at runtime in both modes, so inline styles stay.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The HMR websocket, and only while there is one.
    development
      ? "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*"
      : "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
