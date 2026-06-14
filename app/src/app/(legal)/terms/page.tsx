import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service — AuraFlux',
  description: 'The terms governing your use of the AuraFlux platform.',
};

export default function TermsOfServicePage() {
  return (
    <article className="prose prose-invert prose-sm sm:prose-base max-w-none">
      <h1>Terms of Service</h1>
      <p className="text-muted-foreground text-sm">Effective date: May 26, 2026 &nbsp;·&nbsp; Last updated: May 26, 2026</p>

      <p>
        Please read these Terms of Service ("<strong>Terms</strong>") carefully before using the AuraFlux platform
        (the "<strong>Service</strong>") operated by AuraFlux ("<strong>we</strong>," "<strong>us</strong>," or
        "<strong>our</strong>"). By creating an account or using the Service, you agree to be bound by these Terms.
        If you do not agree, do not use the Service.
      </p>

      <hr />

      <h2>1. Eligibility</h2>
      <p>
        You must be at least 18 years old and have full legal capacity to enter into contracts to use the Service.
        By agreeing to these Terms you represent that you meet these requirements. If you are using the Service
        on behalf of an organization, you represent that you have authority to bind that organization to these Terms.
      </p>

      <hr />

      <h2>2. Description of Service</h2>
      <p>
        AuraFlux is an AI-powered video content production platform that enables customers to source, produce,
        and publish short and long-form video content at scale. The Service includes:
      </p>
      <ul>
        <li>Automated video assembly, editing, and enhancement using AI.</li>
        <li>AI-generated voiceovers, thumbnails, captions, and scripts.</li>
        <li>Integration with third-party content platforms (YouTube, Twitch, Kick) for clip sourcing.</li>
        <li>Publishing to social platforms (YouTube, TikTok, Instagram) via OAuth.</li>
        <li>Template management and recurring job scheduling.</li>
        <li>An operator portal for account management and job oversight.</li>
      </ul>
      <p>
        The specific features available to you depend on your subscription plan (<strong>Operate</strong>,
        <strong>Guided</strong>, <strong>Managed</strong>, or <strong>Custom</strong>).
      </p>

      <hr />

      <h2>3. Account Registration and Security</h2>
      <p>
        You must provide accurate, current, and complete information when creating your account. You are responsible
        for maintaining the confidentiality of your credentials and for all activity that occurs under your account.
        Notify us immediately at <a href="mailto:support@auraflux.co">support@auraflux.co</a> if you suspect
        unauthorized access to your account.
      </p>
      <p>
        You may not share your account credentials, allow others to access your account, or create accounts
        by automated means.
      </p>

      <hr />

      <h2>4. Acceptable Use</h2>
      <p>
        You agree to use the Service only for lawful purposes and in accordance with these Terms and our{' '}
        <a href="/aup">Acceptable Use Policy</a>. You must not:
      </p>
      <ul>
        <li>Use the Service to produce, distribute, or promote illegal, harmful, or misleading content.</li>
        <li>Violate the intellectual property rights of any third party.</li>
        <li>Attempt to reverse engineer, decompile, or extract source code from the Service.</li>
        <li>Interfere with or disrupt the integrity or performance of the Service.</li>
        <li>Use the Service to transmit spam, malware, or other malicious code.</li>
        <li>Circumvent any access controls or attempt to gain unauthorized access to our systems.</li>
        <li>Use the Service in a way that violates the terms of any third-party platform you connect (e.g., YouTube, TikTok).</li>
      </ul>

      <hr />

      <h2>5. Content and Intellectual Property</h2>

      <h3>5.1 Your content</h3>
      <p>
        You retain all rights to the content you submit to the Service ("<strong>Your Content</strong>"). By submitting
        content, you grant AuraFlux a limited, non-exclusive, worldwide license to process, store, transform, and
        transmit Your Content solely to provide the Service.
      </p>
      <p>
        You represent and warrant that: (a) you own or have the necessary rights to Your Content; (b) Your Content
        does not infringe any third party&apos;s intellectual property rights; and (c) Your Content complies with
        all applicable laws.
      </p>

      <h3>5.2 AuraFlux content</h3>
      <p>
        The Service and all associated software, designs, trademarks, and documentation are owned by AuraFlux or
        its licensors. Nothing in these Terms grants you any rights to AuraFlux&apos;s intellectual property except
        the limited right to use the Service as described herein.
      </p>

      <h3>5.3 AI-generated outputs</h3>
      <p>
        Videos, thumbnails, scripts, and other content generated by the Service on your behalf ("<strong>Outputs</strong>")
        are provided to you for your use. You are responsible for reviewing Outputs and ensuring they comply with
        applicable law and third-party platform terms before publishing. We make no representation that AI-generated
        Outputs are free of errors, bias, or intellectual property concerns.
      </p>

      <hr />

      <h2>6. Third-Party Platforms and APIs</h2>
      <p>
        The Service integrates with third-party platforms including Google/YouTube, TikTok, Instagram, Twitch, and Kick.
        Your use of those integrations is subject to those platforms&apos; own terms of service and privacy policies.
        We are not responsible for the actions, availability, or content of third-party platforms.
      </p>
      <p>
        By connecting a third-party platform account, you authorize us to use the platform API on your behalf
        as you direct. You may disconnect any platform at any time from Settings → My Channels.
      </p>

      <hr />

      <h2>7. Subscriptions, Credits, and Billing</h2>

      <h3>7.1 Subscription plans</h3>
      <p>
        The Service is offered on a monthly subscription basis. Subscriptions renew automatically at the end of
        each billing cycle unless cancelled before the renewal date.
      </p>

      <h3>7.2 Credits</h3>
      <p>
        Each plan includes a monthly credit allowance. Credits are used when the platform processes jobs on your
        behalf. Credits expire at the end of the billing cycle and do not roll over unless your plan specifies
        otherwise. Additional credit packs may be purchased.
      </p>

      <h3>7.3 Payment</h3>
      <p>
        Payments are processed by Stripe. You authorize us to charge the payment method on file for all
        subscription fees and credit pack purchases. You are responsible for keeping your payment information
        current. Unpaid invoices may result in suspension of your account.
      </p>

      <h3>7.4 Refunds</h3>
      <p>
        For details on refunds and cancellation, see our <a href="/refunds">Refund &amp; Subscription Policy</a>.
      </p>

      <hr />

      <h2>8. Disclaimer of Warranties</h2>
      <p>
        THE SERVICE IS PROVIDED "<strong>AS IS</strong>" AND "<strong>AS AVAILABLE</strong>" WITHOUT WARRANTIES OF
        ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
        UNINTERRUPTED, ERROR-FREE, OR THAT OUTPUTS WILL MEET YOUR EXPECTATIONS.
      </p>

      <hr />

      <h2>9. Limitation of Liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL AURAFLUX, ITS DIRECTORS, EMPLOYEES,
        AGENTS, OR LICENSORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES,
        INCLUDING LOSS OF PROFITS, DATA, GOODWILL, OR BUSINESS INTERRUPTION, ARISING OUT OF OR RELATING TO
        THESE TERMS OR YOUR USE OF THE SERVICE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
      </p>
      <p>
        OUR TOTAL CUMULATIVE LIABILITY TO YOU FOR ANY CLAIMS ARISING OUT OF OR RELATED TO THE SERVICE SHALL NOT
        EXCEED THE GREATER OF (A) THE AMOUNTS YOU PAID TO AURAFLUX IN THE THREE MONTHS PRECEDING THE CLAIM OR
        (B) ONE HUNDRED DOLLARS ($100).
      </p>

      <hr />

      <h2>10. Indemnification</h2>
      <p>
        You agree to indemnify, defend, and hold harmless AuraFlux and its officers, directors, employees, and
        agents from any claims, liabilities, damages, losses, and expenses (including reasonable legal fees) arising
        out of or in connection with: (a) Your Content; (b) your use of the Service; (c) your violation of these
        Terms; or (d) your violation of any third party&apos;s rights.
      </p>

      <hr />

      <h2>11. Termination</h2>
      <p>
        You may cancel your account at any time from Settings → Billing. We may suspend or terminate your account
        if you violate these Terms, engage in fraudulent activity, or if required by law. Upon termination, your
        access to the Service will cease and your data will be deleted in accordance with our{' '}
        <a href="/privacy">Privacy Policy</a>.
      </p>
      <p>
        Sections 5, 8, 9, 10, 12, and 13 of these Terms survive termination.
      </p>

      <hr />

      <h2>12. Governing Law and Dispute Resolution</h2>
      <p>
        These Terms are governed by the laws of the State of Delaware, without regard to conflict of law principles.
        Any dispute arising from these Terms or your use of the Service shall be resolved by binding arbitration
        administered by the American Arbitration Association under its Consumer Arbitration Rules, except that
        either party may seek injunctive relief in a court of competent jurisdiction. YOU WAIVE ANY RIGHT TO
        PARTICIPATE IN A CLASS ACTION LAWSUIT OR CLASS-WIDE ARBITRATION.
      </p>

      <hr />

      <h2>13. Changes to These Terms</h2>
      <p>
        We may update these Terms from time to time. We will provide at least 14 days&apos; notice before material
        changes take effect by emailing you or posting a notice within the Service. Continued use of the Service
        after the effective date constitutes acceptance of the revised Terms.
      </p>

      <hr />

      <h2>14. General</h2>
      <ul>
        <li><strong>Entire agreement:</strong> These Terms, together with our Privacy Policy, Cookie Policy, Acceptable Use Policy, and Refund Policy, constitute the entire agreement between you and AuraFlux.</li>
        <li><strong>Severability:</strong> If any provision is found unenforceable, the remaining provisions remain in full force.</li>
        <li><strong>Waiver:</strong> Our failure to enforce any provision does not constitute a waiver of our right to enforce it later.</li>
        <li><strong>Assignment:</strong> You may not assign these Terms without our prior written consent. We may assign these Terms without restriction.</li>
      </ul>

      <hr />

      <h2>15. Contact Us</h2>
      <address className="not-italic">
        <strong>AuraFlux</strong><br />
        Email: <a href="mailto:support@auraflux.co">support@auraflux.co</a><br />
        Website: <a href="https://auraflux.co">auraflux.co</a>
      </address>
    </article>
  );
}
