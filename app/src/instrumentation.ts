/**
 * Next.js instrumentation hook — CPD-177
 * Loads the New Relic APM agent on the server side only.
 * Runs once when the Next.js server starts (edge + Node runtimes separately).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('newrelic');
  }
}
