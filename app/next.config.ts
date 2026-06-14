import path from 'path';
import type { NextConfig } from 'next';

// Legacy /dashboard/* → new clean URL redirects (permanent = 308 so bookmarks update)
const dashboardRedirects = async () => [
  { source: '/dashboard',                           destination: '/home',                   permanent: true },
  { source: '/dashboard/jobs',                      destination: '/myjobs',                 permanent: true },
  { source: '/dashboard/jobs/new',                  destination: '/myjobs/new',             permanent: true },
  { source: '/dashboard/jobs/active',               destination: '/myjobs/active',          permanent: true },
  { source: '/dashboard/jobs/history',              destination: '/myjobs/history',         permanent: true },
  { source: '/dashboard/jobs/:jobId',               destination: '/myjobs/:jobId',          permanent: true },
  { source: '/dashboard/staging',                   destination: '/review',                 permanent: true },
  { source: '/dashboard/schedule',                  destination: '/schedule',               permanent: true },
  { source: '/dashboard/templates',                 destination: '/templates',              permanent: true },
  { source: '/dashboard/billing',                   destination: '/billing',                permanent: true },
  { source: '/dashboard/credits',                   destination: '/credits',                permanent: true },
  { source: '/dashboard/plans',                     destination: '/plans',                  permanent: true },
  { source: '/dashboard/support',                   destination: '/support',                permanent: true },
  { source: '/dashboard/profile',                   destination: '/profile',                permanent: true },
  { source: '/dashboard/settings',                  destination: '/settings',               permanent: true },
  { source: '/dashboard/settings/api-keys',         destination: '/settings/api-keys',      permanent: true },
  { source: '/dashboard/settings/social-connect',   destination: '/settings/social',        permanent: true },
  { source: '/dashboard/settings/source-channels',  destination: '/settings/channels',      permanent: true },
  { source: '/dashboard/settings/team',             destination: '/settings/team',          permanent: true },
  { source: '/dashboard/concierge',                 destination: '/concierge',              permanent: true },
  { source: '/dashboard/generate',                  destination: '/generate',               permanent: true },
  { source: '/dashboard/operator',                  destination: '/operator',               permanent: true },
  { source: '/dashboard/team/accept',               destination: '/team/accept',            permanent: true },
  { source: '/dashboard/admin/overview',            destination: '/admin',                  permanent: true },
  { source: '/dashboard/admin/crm',                 destination: '/admin/crm',              permanent: true },
  { source: '/dashboard/admin/crm/:accountId',      destination: '/admin/crm/:accountId',   permanent: true },
  { source: '/dashboard/admin/customers',           destination: '/admin/customers',        permanent: true },
  { source: '/dashboard/admin/permissions',         destination: '/admin/permissions',      permanent: true },
  { source: '/dashboard/admin/support',             destination: '/admin/support',          permanent: true },
  { source: '/dashboard/admin/users',               destination: '/admin/users',            permanent: true },
];

const nextConfig: NextConfig = {
  // instrumentation.ts is supported natively in Next.js 15+ — no config flag needed
  turbopack: {
    root: path.resolve(__dirname),
  },
  redirects: dashboardRedirects,
};

export default nextConfig;
