import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Refund & Subscription Policy — AuraFlux',
  description: 'Billing, cancellation, and refund terms for AuraFlux subscriptions and credit packs.',
};

export default function RefundPolicyPage() {
  return (
    <article className="prose prose-invert prose-sm sm:prose-base max-w-none">
      <h1>Refund &amp; Subscription Policy</h1>
      <p className="text-muted-foreground text-sm">Effective date: May 26, 2026 &nbsp;·&nbsp; Last updated: May 26, 2026</p>

      <p>
        This Refund &amp; Subscription Policy ("<strong>Refund Policy</strong>") describes the billing terms,
        cancellation process, and refund eligibility for AuraFlux subscriptions and credit pack purchases.
        It is incorporated by reference into our <a href="/terms">Terms of Service</a>.
      </p>

      <hr />

      <h2>1. Subscription Plans</h2>
      <p>AuraFlux offers the following monthly subscription plans:</p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Monthly Credits</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Operate</strong></td>
              <td>50</td>
              <td>Full platform access — self-managed by the customer</td>
            </tr>
            <tr>
              <td><strong>Guided</strong></td>
              <td>200</td>
              <td>Full platform access + operator monitoring and guidance</td>
            </tr>
            <tr>
              <td><strong>Managed</strong></td>
              <td>1,000</td>
              <td>Fully done-for-you — operator runs everything on your behalf</td>
            </tr>
            <tr>
              <td><strong>Custom</strong></td>
              <td>Unlimited</td>
              <td>Enterprise / white-label — bespoke terms apply</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Pricing for each plan is displayed at sign-up and in your account settings. AuraFlux reserves the right
        to change pricing with at least 30 days&apos; notice to existing subscribers.
      </p>

      <hr />

      <h2>2. Billing and Renewal</h2>
      <ul>
        <li>Subscriptions are billed monthly in advance on the date you originally subscribed.</li>
        <li>All payments are processed by <strong>Stripe</strong> in USD.</li>
        <li>Subscriptions renew automatically at the end of each billing cycle unless cancelled before the renewal date.</li>
        <li>You are responsible for keeping your payment information current. Failed payments may result in account suspension after a grace period of 3 business days.</li>
        <li>You will receive a receipt by email for each successful charge.</li>
      </ul>

      <hr />

      <h2>3. Credits</h2>
      <ul>
        <li>Each subscription plan includes a monthly credit allowance credited at the start of each billing cycle.</li>
        <li>Credits are consumed when the AuraFlux platform processes jobs (video production, publishing, AI generation, etc.).</li>
        <li><strong>Credits do not roll over.</strong> Any unused credits at the end of a billing cycle expire and are not refunded or carried to the next cycle.</li>
        <li>Credit pack add-ons purchased outside the subscription follow the same non-rollover policy; purchased packs expire at the end of the billing cycle in which they were purchased.</li>
      </ul>

      <hr />

      <h2>4. Credit Pack Purchases</h2>
      <ul>
        <li>Additional credit packs may be purchased at any time from Settings → Billing.</li>
        <li>Credit pack purchases are non-refundable once the credits have been consumed.</li>
        <li>If no credits from a pack have been consumed and you request a refund within 48 hours of purchase, we will review the request on a case-by-case basis.</li>
      </ul>

      <hr />

      <h2>5. Cancellation</h2>
      <ul>
        <li>You may cancel your subscription at any time from <strong>Settings → Billing</strong> in the AuraFlux platform.</li>
        <li>Cancellation takes effect at the end of the current billing cycle. You retain access to the Service and your monthly credit allowance until that date.</li>
        <li>Cancelling does not delete your account. Your data is retained in accordance with our <a href="/privacy">Privacy Policy</a>.</li>
        <li>To permanently delete your account, contact <a href="mailto:support@auraflux.co">support@auraflux.co</a> after cancelling.</li>
      </ul>

      <hr />

      <h2>6. Refund Eligibility</h2>

      <h3>6.1 General policy — no prorated refunds</h3>
      <p>
        AuraFlux subscriptions are non-refundable. We do not issue prorated refunds for partial months, unused
        credits, or early cancellations. When you cancel, you continue to have access to the Service until the
        end of your paid billing period.
      </p>

      <h3>6.2 Exceptions we will consider</h3>
      <p>We will review refund requests on a case-by-case basis in the following circumstances:</p>
      <ul>
        <li>
          <strong>Duplicate charge:</strong> You were charged more than once for the same billing cycle due to a
          processing error. Submit your request within 14 days of the charge.
        </li>
        <li>
          <strong>Service unavailability:</strong> The Service experienced a confirmed outage of more than 72
          consecutive hours in a given billing cycle. We may issue a prorated credit for the downtime period.
        </li>
        <li>
          <strong>Unauthorized charge:</strong> A charge was made to your account without your authorization.
          Submit your request within 14 days and include evidence of the unauthorized activity.
        </li>
      </ul>
      <p>
        To request a refund, email <a href="mailto:support@auraflux.co">support@auraflux.co</a> with your
        account email, the charge date, the amount, and the reason for your request.
      </p>

      <h3>6.3 AUP violations</h3>
      <p>
        Accounts terminated for violating our <a href="/aup">Acceptable Use Policy</a> or{' '}
        <a href="/terms">Terms of Service</a> are not eligible for refunds under any circumstances.
      </p>

      <hr />

      <h2>7. Managed and Custom Plans</h2>
      <p>
        Managed and Custom plan billing terms may differ from the above and are governed by your individual service
        agreement with AuraFlux. In the event of a conflict, the terms of your service agreement take precedence.
      </p>

      <hr />

      <h2>8. Price Changes</h2>
      <p>
        We reserve the right to change subscription pricing. We will notify you at least 30 days before a
        price change takes effect by email or via a notice in the Service. If you do not cancel before the
        price change takes effect, you agree to be charged the new price at your next renewal.
      </p>

      <hr />

      <h2>9. Taxes</h2>
      <p>
        Prices are exclusive of applicable taxes (including VAT, GST, or sales tax). AuraFlux will add applicable
        taxes to your invoice based on your billing address, as required by law. You are responsible for any
        applicable taxes on your subscription.
      </p>

      <hr />

      <h2>10. Questions and Disputes</h2>
      <p>
        For billing questions or to dispute a charge, contact us at:
      </p>
      <address className="not-italic">
        <strong>AuraFlux Billing Support</strong><br />
        Email: <a href="mailto:support@auraflux.co">support@auraflux.co</a><br />
        Website: <a href="https://app.auraflux.co">app.auraflux.co</a>
      </address>
      <p>
        Please allow up to 3 business days for a response. If you initiate a chargeback with your bank before
        contacting us, we reserve the right to suspend your account pending investigation.
      </p>
    </article>
  );
}
