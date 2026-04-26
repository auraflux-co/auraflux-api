# Security

## Reporting a vulnerability

Please **do not** open a public GitHub issue for undisclosed security problems.

- Contact the repository maintainers through a **private** channel they publish (email, security advisory form, or GitHub **Security** → **Report a vulnerability** if enabled).
- Include enough detail to reproduce: affected component, version/commit, and impact.

## Secrets in this repository

- **Never commit** `.env`, Drive key JSON, API tokens, or customer data.
- Google Drive OAuth: this codebase does **not** ship OAuth client secrets. Set `DRIVE_CLIENT_ID`, `DRIVE_CLIENT_SECRET`, and `DRIVE_REFRESH_TOKEN` in your own `.env` (see `.env.example`).

## Out of scope

General support questions belong in Issues or Discussions, not the security channel.
