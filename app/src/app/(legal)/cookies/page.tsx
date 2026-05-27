import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Cookie Policy — AuraFlux',
  description: 'How AuraFlux uses cookies and similar tracking technologies.',
};

export default function CookiePolicyPage() {
  return (
    <article className="prose prose-invert prose-sm sm:prose-base max-w-none">
      <h1>Cookie Policy</h1>
      <p className="text-muted-foreground text-sm">Effective date: May 26, 2026 &nbsp;·&nbsp; Last updated: May 26, 2026</p>

      <p>
        This Cookie Policy explains how AuraFlux ("<strong>we</strong>," "<strong>our</strong>," or
        "<strong>us</strong>") uses cookies and similar tracking technologies on the AuraFlux platform
        (the "<strong>Service</strong>") at <strong>app.auraflux.co</strong>. This policy should be read
        alongside our <a href="/privacy">Privacy Policy</a>.
      </p>

      <hr />

      <h2>1. What Are Cookies?</h2>
      <p>
        Cookies are small text files placed on your device by a website when you visit it. They are widely used
        to make websites work, or work more efficiently, and to provide information to website operators.
        Similar technologies include local storage, session storage, and web beacons (pixel tags).
      </p>

      <hr />

      <h2>2. Cookies We Use</h2>

      <h3>2.1 Strictly necessary cookies</h3>
      <p>
        These cookies are essential for the Service to function. They cannot be disabled. Without them, features
        like signing in and maintaining your session would not work.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Cookie</th>
              <th>Provider</th>
              <th>Purpose</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>__session</code></td>
              <td>Clerk</td>
              <td>User authentication session token</td>
              <td>Session</td>
            </tr>
            <tr>
              <td><code>__client_uat</code></td>
              <td>Clerk</td>
              <td>Authentication state sync across tabs</td>
              <td>1 year</td>
            </tr>
            <tr>
              <td><code>__cf_bm</code></td>
              <td>Cloudflare</td>
              <td>Bot detection and DDoS protection</td>
              <td>30 minutes</td>
            </tr>
            <tr>
              <td><code>cf_clearance</code></td>
              <td>Cloudflare</td>
              <td>Records successful challenge completion</td>
              <td>1 year</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>2.2 Functional cookies</h3>
      <p>
        These cookies enable enhanced functionality and personalisation. They may be set by us or by third-party
        providers whose services we use. Disabling these may affect some features of the Service.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Cookie / Storage</th>
              <th>Provider</th>
              <th>Purpose</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>theme</code></td>
              <td>AuraFlux</td>
              <td>Stores your dark/light mode preference</td>
              <td>1 year</td>
            </tr>
            <tr>
              <td>Local storage keys</td>
              <td>AuraFlux</td>
              <td>Saves in-progress job form state to prevent data loss on reload</td>
              <td>Until cleared</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>2.3 Analytics and performance cookies</h3>
      <p>
        These cookies help us understand how the Service is being used so we can improve it. Data is aggregated
        and does not identify you individually.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Cookie / Tracker</th>
              <th>Provider</th>
              <th>Purpose</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>New Relic browser agent</td>
              <td>New Relic</td>
              <td>Real user monitoring, page performance, JavaScript errors</td>
              <td>Session</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        New Relic&apos;s browser agent collects anonymised performance metrics such as page load times, browser type,
        and JavaScript errors. It does not collect personally identifiable information beyond IP address (which is
        hashed). See New Relic&apos;s{' '}
        <a href="https://newrelic.com/termsandconditions/privacy" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>.
      </p>

      <h3>2.4 No advertising or tracking cookies</h3>
      <p>
        AuraFlux does not use advertising networks, retargeting pixels, or third-party behavioural tracking
        cookies. We do not sell your data to advertisers or data brokers.
      </p>

      <hr />

      <h2>3. Third-Party Cookies from Platform Connections</h2>
      <p>
        When you authorize AuraFlux to connect to third-party platforms (YouTube, TikTok, Instagram, Twitch, Kick),
        those platforms may set their own cookies during the OAuth authorization flow. Those cookies are governed
        by the respective platform&apos;s privacy and cookie policies, not ours.
      </p>

      <hr />

      <h2>4. Managing Cookies</h2>
      <p>
        Most web browsers allow you to control cookies through their settings. You can choose to:
      </p>
      <ul>
        <li>Block all cookies (note: this will break sign-in and core Service functionality).</li>
        <li>Delete existing cookies from your browser.</li>
        <li>Configure your browser to warn you before accepting cookies.</li>
      </ul>
      <p>Instructions for managing cookies in common browsers:</p>
      <ul>
        <li><a href="https://support.google.com/chrome/answer/95647" target="_blank" rel="noreferrer">Google Chrome</a></li>
        <li><a href="https://support.mozilla.org/en-US/kb/cookies-information-websites-store-on-your-computer" target="_blank" rel="noreferrer">Mozilla Firefox</a></li>
        <li><a href="https://support.apple.com/guide/safari/manage-cookies-sfri11471/mac" target="_blank" rel="noreferrer">Apple Safari</a></li>
        <li><a href="https://support.microsoft.com/en-us/windows/manage-cookies-in-microsoft-edge" target="_blank" rel="noreferrer">Microsoft Edge</a></li>
      </ul>

      <hr />

      <h2>5. Do Not Track</h2>
      <p>
        Some browsers include a "Do Not Track" (DNT) signal. Because there is no industry-standard response to
        DNT signals, we do not currently alter our data practices based on DNT signals. However, we do not use
        cross-site tracking regardless of DNT.
      </p>

      <hr />

      <h2>6. Changes to This Policy</h2>
      <p>
        We may update this Cookie Policy when we add, change, or remove cookies. Material changes will be
        communicated through the Service or by email.
      </p>

      <hr />

      <h2>7. Contact Us</h2>
      <p>
        If you have questions about our use of cookies, contact us at:
      </p>
      <address className="not-italic">
        <strong>AuraFlux</strong><br />
        Email: <a href="mailto:support@auraflux.co">support@auraflux.co</a>
      </address>
    </article>
  );
}
