import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — AuraFlux',
  description: 'How AuraFlux collects, uses, and protects your personal information.',
};

export default function PrivacyPolicyPage() {
  return (
    <article className="prose prose-invert prose-sm sm:prose-base max-w-none">
      <h1>Privacy Policy</h1>
      <p className="text-muted-foreground text-sm">Effective date: May 26, 2026 &nbsp;·&nbsp; Last updated: May 26, 2026</p>

      <p>
        AuraFlux ("<strong>AuraFlux</strong>," "<strong>we</strong>," "<strong>our</strong>," or "<strong>us</strong>") operates the
        platform available at <strong>app.auraflux.co</strong> and related services (the "<strong>Service</strong>"). This Privacy
        Policy explains what information we collect, how we use it, and the choices you have in connection with
        that information. By using the Service you agree to this policy.
      </p>

      <hr />

      <h2>1. Information We Collect</h2>

      <h3>1.1 Information you provide directly</h3>
      <ul>
        <li><strong>Account information:</strong> name, email address, and password (managed via Clerk, our authentication provider).</li>
        <li><strong>Billing information:</strong> payment card details processed and stored by Stripe. AuraFlux does not store raw card numbers.</li>
        <li><strong>Content you upload:</strong> video files, images, scripts, and other media submitted through the Service.</li>
        <li><strong>Communications:</strong> messages sent to our support team.</li>
      </ul>

      <h3>1.2 Information collected automatically</h3>
      <ul>
        <li><strong>Usage data:</strong> pages visited, features used, job submissions, error logs, and timestamps.</li>
        <li><strong>Device and browser data:</strong> IP address, browser type, operating system, and referring URLs.</li>
        <li><strong>Cookies and similar technologies:</strong> see our <a href="/cookies">Cookie Policy</a>.</li>
        <li><strong>Performance data:</strong> collected by New Relic for application monitoring and error tracking.</li>
      </ul>

      <h3>1.3 Information from third-party platforms you connect</h3>
      <p>
        When you connect a third-party platform account (YouTube, Twitch, Kick, TikTok, or Instagram) through our
        OAuth integration, we receive and store:
      </p>
      <ul>
        <li>OAuth access and refresh tokens (encrypted at rest).</li>
        <li>Platform username or handle and user ID.</li>
        <li>Scopes you have authorized (e.g., the ability to read your channel clips or upload videos).</li>
      </ul>
      <p>We do not receive or store your platform passwords.</p>

      <hr />

      <h2>2. How We Use Your Information</h2>
      <ul>
        <li><strong>To provide the Service:</strong> process job submissions, generate video content, and deliver outputs.</li>
        <li><strong>To publish on your behalf:</strong> use connected platform tokens to source content or publish videos to platforms you have authorized.</li>
        <li><strong>To process payments:</strong> manage subscriptions and credit purchases via Stripe.</li>
        <li><strong>To communicate with you:</strong> send service notifications, billing receipts, and responses to support requests.</li>
        <li><strong>To improve the Service:</strong> analyze usage patterns, diagnose bugs, and develop new features.</li>
        <li><strong>To enforce our policies:</strong> detect and prevent fraud, abuse, and violations of our <a href="/terms">Terms of Service</a>.</li>
        <li><strong>To comply with law:</strong> respond to lawful requests from authorities when required.</li>
      </ul>

      <hr />

      <h2>3. How We Share Your Information</h2>
      <p>We do not sell your personal data. We share information only as follows:</p>

      <h3>3.1 Service providers</h3>
      <p>We engage sub-processors who handle data on our behalf under confidentiality obligations:</p>
      <ul>
        <li><strong>Clerk</strong> — user authentication and session management</li>
        <li><strong>Stripe</strong> — payment processing and billing</li>
        <li><strong>Upload-Post</strong> — white-label OAuth and publishing to TikTok and Instagram</li>
        <li><strong>Cloudflare</strong> — file storage (R2), CDN, and DDoS protection</li>
        <li><strong>Render</strong> — cloud hosting and infrastructure</li>
        <li><strong>New Relic</strong> — application performance monitoring</li>
        <li><strong>Google / Gemini</strong> — AI content analysis and generation</li>
        <li><strong>ElevenLabs</strong> — AI text-to-speech generation</li>
        <li><strong>HeyGen</strong> — AI avatar video generation (Managed plan)</li>
      </ul>

      <h3>3.2 Third-party platforms you connect</h3>
      <p>
        When you instruct us to publish content to YouTube, TikTok, Instagram, Twitch, or Kick, we transmit
        your content and use your OAuth token to interact with those platforms on your behalf.
      </p>

      <h3>3.3 Legal requirements</h3>
      <p>We may disclose information if required by law, court order, or to protect the rights and safety of AuraFlux or others.</p>

      <h3>3.4 Business transfers</h3>
      <p>
        In the event of a merger, acquisition, or sale of assets, your information may be transferred as part of
        that transaction. We will notify you before your data is transferred and becomes subject to a different privacy policy.
      </p>

      <hr />

      <h2>4. YouTube API Services</h2>
      <p>
        AuraFlux uses the <strong>YouTube API Services</strong> to allow you to source clips from YouTube channels
        and publish videos to YouTube on your behalf. By connecting your YouTube account, you authorize AuraFlux
        to access YouTube data under the scopes you approve.
      </p>
      <ul>
        <li>We access YouTube data only for the purposes described above and only while your authorization is active.</li>
        <li>We store your YouTube OAuth tokens encrypted in our database and use them solely to perform actions you have requested.</li>
        <li>You can revoke AuraFlux&apos;s access to your YouTube account at any time by visiting your
          {' '}<a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">
            Google security settings
          </a>. Revoking access will disconnect your YouTube account from AuraFlux.</li>
        <li>Our use of YouTube data is also governed by the{' '}
          <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms of Service</a>
          {' '}and the{' '}
          <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google Privacy Policy</a>.
        </li>
      </ul>

      <hr />

      <h2>5. Data Storage and Security</h2>
      <p>
        Your data is stored on servers located in the United States (Render infrastructure, Cloudflare R2 US regions).
        We implement industry-standard security measures including TLS encryption in transit, AES-256-GCM encryption
        for OAuth tokens at rest, and access controls limiting employee access to production data.
      </p>
      <p>
        No method of transmission or storage is 100% secure. If you believe your account has been compromised,
        contact us immediately at <a href="mailto:support@auraflux.co">support@auraflux.co</a>.
      </p>

      <hr />

      <h2>6. Data Retention</h2>
      <ul>
        <li><strong>Account data:</strong> retained while your account is active and for 90 days after deletion.</li>
        <li><strong>Job outputs (video files):</strong> retained for 30 days after creation, then automatically deleted from storage.</li>
        <li><strong>OAuth tokens:</strong> retained until you disconnect the platform or delete your account.</li>
        <li><strong>Billing records:</strong> retained for 7 years as required by applicable law.</li>
        <li><strong>Usage logs:</strong> retained for 90 days for debugging and security purposes.</li>
      </ul>

      <hr />

      <h2>7. Your Rights and Choices</h2>

      <h3>7.1 All users</h3>
      <ul>
        <li><strong>Access:</strong> request a copy of the personal data we hold about you.</li>
        <li><strong>Correction:</strong> update inaccurate information through your account settings or by contacting us.</li>
        <li><strong>Deletion:</strong> request deletion of your account and associated personal data.</li>
        <li><strong>Connected platforms:</strong> disconnect any third-party platform at any time in Settings → My Channels.</li>
      </ul>

      <h3>7.2 California residents (CCPA)</h3>
      <p>
        California residents have the right to know what personal information we collect and how it is used,
        the right to delete personal information, and the right to opt out of the sale of personal information
        (we do not sell personal information). To exercise these rights, contact us at{' '}
        <a href="mailto:support@auraflux.co">support@auraflux.co</a>.
      </p>

      <h3>7.3 EEA / UK residents (GDPR)</h3>
      <p>
        If you are located in the European Economic Area or the United Kingdom, you have rights under the GDPR
        or UK GDPR including the right to access, rectification, erasure, restriction of processing, data
        portability, and to object to processing. Our legal basis for processing is primarily contract performance
        (providing the Service) and legitimate interests (security, fraud prevention). Contact us to exercise
        your rights or to lodge a complaint with your local supervisory authority.
      </p>

      <hr />

      <h2>8. Children&apos;s Privacy</h2>
      <p>
        The Service is not directed to children under the age of 13 (or 16 in the EEA). We do not knowingly
        collect personal information from children. If you believe we have collected information from a child,
        please contact us and we will promptly delete it.
      </p>

      <hr />

      <h2>9. Third-Party Links</h2>
      <p>
        The Service may contain links to third-party websites. We are not responsible for the privacy practices
        of those sites. We encourage you to review their privacy policies before providing any personal information.
      </p>

      <hr />

      <h2>10. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. We will notify you of material changes by email
        or by a notice within the Service at least 14 days before the change takes effect. Continued use of
        the Service after the effective date constitutes acceptance of the revised policy.
      </p>

      <hr />

      <h2>11. Contact Us</h2>
      <p>
        For privacy-related questions, requests, or complaints, contact us at:
      </p>
      <address className="not-italic">
        <strong>AuraFlux</strong><br />
        Email: <a href="mailto:support@auraflux.co">support@auraflux.co</a><br />
        Website: <a href="https://app.auraflux.co">app.auraflux.co</a>
      </address>
    </article>
  );
}
