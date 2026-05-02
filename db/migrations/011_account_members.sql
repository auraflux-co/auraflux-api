-- Migration 011: Multi-user RBAC — account members (CPD-130)
-- An account is identified by the owner's Clerk user ID (= customerId).
-- Members are other Clerk users invited to operate within that account.

CREATE TABLE IF NOT EXISTS account_members (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    TEXT        NOT NULL,  -- owner's Clerk userId (the account root)
  member_id     TEXT,                  -- invited user's Clerk userId (NULL until accepted)
  role          TEXT        NOT NULL,  -- 'owner' | 'admin' | 'member' | 'billing'
  invited_by    TEXT        NOT NULL,  -- Clerk userId of the person who sent the invite
  invited_email TEXT        NOT NULL,  -- email the invite was sent to
  invite_token  TEXT        UNIQUE,    -- secure token for accept link (NULL after accepted)
  status        TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'active' | 'revoked'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT account_members_role_check CHECK (role IN ('owner','admin','member','billing')),
  CONSTRAINT account_members_status_check CHECK (status IN ('pending','active','revoked')),
  UNIQUE (account_id, member_id),
  UNIQUE (account_id, invited_email)
);

CREATE INDEX IF NOT EXISTS idx_account_members_account    ON account_members (account_id);
CREATE INDEX IF NOT EXISTS idx_account_members_member     ON account_members (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_account_members_token      ON account_members (invite_token) WHERE invite_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_account_members_email      ON account_members (invited_email);

-- Owner rows are created lazily when a customer first accesses the team page
-- rather than seeded here, since email data is not available in the jobs table.

INSERT INTO schema_migrations (version) VALUES ('011_account_members') ON CONFLICT DO NOTHING;
