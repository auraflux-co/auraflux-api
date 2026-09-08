import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { emailOTP } from 'better-auth/plugins';
import { Pool } from 'pg';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { sendAuthEmail } from '@/lib/auth/send-email';

export const AUTH_BASE_PATH = '/api/id';

let _pool: Pool | null = null;

function getPool(): Pool | null {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const isLocal =
    url.includes('localhost') || url.includes('127.0.0.1');
  _pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  });
  return _pool;
}

function authSecret(): string {
  return process.env.BETTER_AUTH_SECRET || process.env.AUTH_JWT_SECRET || '';
}

/** Google OAuth credentials — infrastructure only; omit provider when unset. */
export function googleSocialProviderFromEnv():
  | { clientId: string; clientSecret: string; prompt: 'select_account' }
  | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, prompt: 'select_account' };
}

export function createAurafluxAuth() {
  const pool = getPool();
  const secret = authSecret();
  if (!pool || !secret || secret.length < 32) return null;

  const baseURL =
    process.env.BETTER_AUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'https://app.auraflux.co';

  const google = googleSocialProviderFromEnv();

  return betterAuth({
    database: pool,
    secret,
    baseURL,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [
      baseURL,
      'https://app.auraflux.co',
      'http://localhost:3000',
      'http://localhost:3001',
    ],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
      sendResetPassword: async ({ user, url }) => {
        // Fire-and-forget to avoid timing leaks; Vercel keeps the isolate warm enough for SMTP.
        void sendAuthEmail({
          to: user.email,
          subject: 'Reset your AuraFlux password',
          text:
            `Reset your password:\n\n${url}\n\n` +
            `If you did not request this, you can ignore this email.`,
        });
      },
    },
    // Migration 036 uses snake_case; Better Auth defaults to camelCase columns.
    user: {
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      additionalFields: {},
    },
    session: {
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google'],
      },
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    ...(google
      ? {
          socialProviders: {
            google,
          },
        }
      : {}),
    plugins: [
      nextCookies(),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        disableSignUp: true,
        async sendVerificationOTP({ email, otp, type }) {
          const subject =
            type === 'forget-password'
              ? 'Your AuraFlux password reset code'
              : type === 'email-verification'
                ? 'Verify your AuraFlux email'
                : 'Your AuraFlux sign-in code';
          const purpose =
            type === 'forget-password'
              ? 'reset your password'
              : type === 'email-verification'
                ? 'verify your email'
                : 'sign in';
          void sendAuthEmail({
            to: email,
            subject,
            text:
              `Your one-time code to ${purpose} is:\n\n${otp}\n\n` +
              `It expires in 5 minutes. If you did not request this, ignore this email.`,
          });
        },
      }),
    ],
  });
}

let cached: ReturnType<typeof createAurafluxAuth> | undefined;

export function getAuth() {
  if (cached !== undefined) return cached;
  cached = createAurafluxAuth();
  return cached;
}

export type AurafluxAuth = NonNullable<ReturnType<typeof getAuth>>;
