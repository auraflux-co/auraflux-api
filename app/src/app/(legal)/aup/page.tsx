import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Acceptable Use Policy — AuraFlux',
  description: 'What you can and cannot do with AuraFlux.',
};

export default function AcceptableUsePolicyPage() {
  return (
    <article className="prose prose-invert prose-sm sm:prose-base max-w-none">
      <h1>Acceptable Use Policy</h1>
      <p className="text-muted-foreground text-sm">Effective date: May 26, 2026 &nbsp;·&nbsp; Last updated: May 26, 2026</p>

      <p>
        This Acceptable Use Policy ("<strong>AUP</strong>") governs your use of the AuraFlux platform and services
        (the "<strong>Service</strong>"). It is incorporated by reference into our{' '}
        <a href="/terms">Terms of Service</a>. By using the Service, you agree to abide by this policy.
      </p>
      <p>
        AuraFlux is a professional content production tool. We expect all users and operators to use it
        responsibly and in compliance with applicable law.
      </p>

      <hr />

      <h2>1. Prohibited Content</h2>
      <p>You must not use the Service to create, process, store, publish, or distribute content that:</p>

      <h3>1.1 Illegal content</h3>
      <ul>
        <li>Violates any applicable local, national, or international law or regulation.</li>
        <li>Constitutes child sexual abuse material (CSAM) or any sexualization of minors.</li>
        <li>Promotes, facilitates, or glorifies terrorism, violence, or hate crimes.</li>
        <li>Infringes any copyright, trademark, trade secret, or other intellectual property right.</li>
        <li>Constitutes defamation, invasion of privacy, or harassment of any individual.</li>
      </ul>

      <h3>1.2 Harmful and misleading content</h3>
      <ul>
        <li>Contains materially false or misleading information that could deceive viewers or cause harm.</li>
        <li>Constitutes coordinated inauthentic behavior, including the creation of fake personas or sockpuppet accounts.</li>
        <li>Promotes dangerous health misinformation (e.g., fake medical advice, anti-vaccine propaganda).</li>
        <li>Contains non-consensual intimate imagery (deepfakes or otherwise).</li>
        <li>Impersonates any person, company, or brand in a deceptive or harmful way.</li>
      </ul>

      <h3>1.3 Hate speech and discrimination</h3>
      <ul>
        <li>Attacks or demeans individuals or groups based on race, ethnicity, national origin, religion, gender,
          sexual orientation, disability, or other protected characteristics.</li>
        <li>Promotes white supremacy, neo-Nazism, or similar extremist ideologies.</li>
      </ul>

      <h3>1.4 Spam and commercial abuse</h3>
      <ul>
        <li>Uses the Service to produce bulk unsolicited or deceptive content at scale designed to manipulate
          platform algorithms or spam audiences.</li>
        <li>Promotes fraudulent schemes, pyramid schemes, or multi-level marketing in deceptive ways.</li>
      </ul>

      <hr />

      <h2>2. Prohibited Use of AI Features</h2>
      <p>
        AuraFlux uses AI to generate scripts, voiceovers, thumbnails, and video content. You must not use
        these AI capabilities to:
      </p>
      <ul>
        <li>Generate synthetic media that is designed to deceive viewers about its AI-generated nature in contexts where such deception is harmful.</li>
        <li>Create deepfake content depicting real, identifiable individuals without their consent — particularly sexual deepfakes or reputation-damaging fabrications.</li>
        <li>Produce content that violates the content policies of any platform to which you publish (YouTube, TikTok, Instagram, etc.).</li>
        <li>Automate the creation and upload of low-quality spam content designed solely to game platform recommendation algorithms.</li>
      </ul>

      <hr />

      <h2>3. Third-Party Platform Compliance</h2>
      <p>
        When you use AuraFlux to source content from or publish to third-party platforms (YouTube, Twitch, Kick,
        TikTok, Instagram), you must comply with those platforms&apos; terms of service and community guidelines in
        addition to this AUP. You are solely responsible for ensuring your content meets the requirements of
        each platform you publish to.
      </p>
      <p>Key requirements include (but are not limited to):</p>
      <ul>
        <li><strong>YouTube / Google:</strong> YouTube Terms of Service, YouTube Community Guidelines, and YouTube API Services Terms of Service.</li>
        <li><strong>TikTok / Instagram:</strong> The respective platform Terms of Service and Community Guidelines.</li>
        <li><strong>Twitch / Kick:</strong> Respective Terms of Service and Community Guidelines.</li>
      </ul>
      <p>
        If a third-party platform suspends or terminates access to your account as a result of your use of
        AuraFlux, we are not liable and such termination does not entitle you to a refund.
      </p>

      <hr />

      <h2>4. Account and System Integrity</h2>
      <p>You must not:</p>
      <ul>
        <li>Share your AuraFlux account credentials or API keys with unauthorized parties.</li>
        <li>Attempt to access systems, data, or accounts that you are not authorized to access.</li>
        <li>Use the Service to probe, scan, or test the vulnerability of any system or network.</li>
        <li>Introduce malware, viruses, Trojan horses, or other malicious code into the Service.</li>
        <li>Attempt to overload, flood, or conduct denial-of-service attacks on the Service.</li>
        <li>Use automated scripts to interact with the Service in ways that violate these Terms.</li>
      </ul>

      <hr />

      <h2>5. Operator Responsibilities</h2>
      <p>
        If you are a Managed or Custom plan operator managing the Service on behalf of end customers, you are
        responsible for ensuring that:
      </p>
      <ul>
        <li>Your customers understand and agree to this AUP.</li>
        <li>All content produced on behalf of your customers complies with this AUP.</li>
        <li>You do not use the Service to produce content that your customers have not authorized.</li>
        <li>You have appropriate agreements and consents in place with your customers for the use of their channel data, OAuth tokens, and brand assets.</li>
      </ul>

      <hr />

      <h2>6. Enforcement</h2>
      <p>
        AuraFlux reserves the right to investigate any suspected violation of this AUP. If we determine that a
        violation has occurred, we may take any of the following actions, at our sole discretion:
      </p>
      <ul>
        <li>Issue a warning.</li>
        <li>Suspend job processing for the offending account.</li>
        <li>Remove or withhold content outputs.</li>
        <li>Terminate the account with or without prior notice.</li>
        <li>Report the violation to law enforcement or relevant regulatory authorities.</li>
      </ul>
      <p>
        Termination for AUP violations does not entitle you to a refund of any fees paid.
      </p>

      <hr />

      <h2>7. Reporting Violations</h2>
      <p>
        If you believe someone is violating this AUP, please report it to us at{' '}
        <a href="mailto:support@auraflux.co">support@auraflux.co</a>. We will investigate all credible reports
        and respond appropriately.
      </p>

      <hr />

      <h2>8. Changes to This Policy</h2>
      <p>
        We may update this AUP from time to time. Material changes will be communicated with at least 14 days&apos;
        notice. Continued use of the Service following the effective date constitutes acceptance of the revised AUP.
      </p>

      <hr />

      <h2>9. Contact Us</h2>
      <address className="not-italic">
        <strong>AuraFlux</strong><br />
        Email: <a href="mailto:support@auraflux.co">support@auraflux.co</a><br />
        Website: <a href="https://app.auraflux.co">app.auraflux.co</a>
      </address>
    </article>
  );
}
