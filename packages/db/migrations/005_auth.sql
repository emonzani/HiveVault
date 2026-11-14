-- Authentication, authorization and audit (plan §8).
--
-- One table of principals for people and API accounts: grants, sessions and the audit log
-- refer to a principal without caring which kind it is.

create table principals (
  id             text primary key,                    -- "usr_..." or "api_..."
  kind           text not null check (kind in ('user', 'api')),
  name           text not null unique,                -- username (lower case) or API account name
  display_name   text not null,
  email          text,
  role           text not null default 'member' check (role in ('admin', 'curator', 'member', 'api')),
  scopes         text[] not null default '{}',        -- API accounts: read, write, ingest, admin
  clearance      smallint not null default 1 check (clearance between 0 and 3),
  status         text not null default 'active' check (status in ('active', 'suspended')),
  expires_at     timestamptz,                          -- API accounts
  allowed_ips    cidr[],                               -- API accounts: null = any
  rate_per_min   int,                                  -- API accounts: null = default
  created_by     text references principals(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_seen_at   timestamptz,
  check (kind = 'api' or role <> 'api'),
  check (kind = 'user' or role = 'api')
);

-- ---------------------------------------------------------------------------
-- Credentials
-- ---------------------------------------------------------------------------
-- TOTP (RFC 6238). The secret is encrypted with the master key. last_step blocks the reuse
-- of a code in the same 30 s window.
create table totp_secrets (
  principal_id  text primary key references principals(id) on delete cascade,
  secret_enc    bytea not null,
  confirmed     boolean not null default false,
  last_step     bigint not null default 0,
  created_at    timestamptz not null default now()
);

create table recovery_codes (
  principal_id  text not null references principals(id) on delete cascade,
  code_hash     text not null,
  used_at       timestamptz,
  primary key (principal_id, code_hash)
);

-- One-time enrollment codes (first TOTP setup, reset by the admin).
create table enrollments (
  code_hash     text primary key,
  principal_id  text not null references principals(id) on delete cascade,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_by    text references principals(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- WebAuthn passkeys.
create table passkeys (
  id            text primary key,                     -- credential id, base64url
  principal_id  text not null references principals(id) on delete cascade,
  public_key    bytea not null,                       -- COSE public key
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_type   text,
  backed_up     boolean not null default false,
  name          text not null default 'Passkey',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_principal_idx on passkeys (principal_id);

-- Public keys and X.509 certificates for the challenge login (signature of user + nonce).
create table public_keys (
  id            text primary key,
  principal_id  text not null references principals(id) on delete cascade,
  kind          text not null check (kind in ('ed25519', 'ecdsa-p256', 'x509')),
  pem           text not null,
  fingerprint   text not null unique,                 -- sha256 of the SPKI
  not_after     timestamptz,                          -- certificates
  name          text not null default 'Chiave',
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index public_keys_principal_idx on public_keys (principal_id) where revoked_at is null;

-- API keys: "cb_<id>_<secret>". Only the sha256 of the secret is stored (the secret has
-- 256 bits of entropy: a slow hash adds nothing).
create table api_keys (
  id            text primary key,
  principal_id  text not null references principals(id) on delete cascade,
  secret_hash   text not null,
  name          text not null default 'Chiave',
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index api_keys_principal_idx on api_keys (principal_id);

-- Single-use challenges (WebAuthn and signature login).
create table auth_challenges (
  id            text primary key,
  purpose       text not null check (purpose in ('passkey-register', 'passkey-login', 'signature-login')),
  principal_id  text references principals(id) on delete cascade,
  challenge     text not null,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index auth_challenges_expiry_idx on auth_challenges (expires_at);

-- Failed logins, for the progressive lockout (survives restarts).
create table auth_failures (
  id         bigint generated always as identity primary key,
  username   text not null,
  ip         inet,
  at         timestamptz not null default now()
);
create index auth_failures_user_idx on auth_failures (username, at desc);

-- ---------------------------------------------------------------------------
-- Sessions: the cookie holds a random token, the table holds its sha256.
-- ---------------------------------------------------------------------------
create table sessions (
  id            text primary key,                     -- sha256(token), hex
  principal_id  text not null references principals(id) on delete cascade,
  method        text not null,                        -- totp, recovery, passkey, signature
  csrf          text not null,
  ip            inet,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index sessions_principal_idx on sessions (principal_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Authorization: permissions on vaults. Levels are ordered: read < write < curate < admin.
-- The owner of a cell vault ("user:<id>") has admin on it without a grant.
-- ---------------------------------------------------------------------------
create table vault_grants (
  principal_id  text not null references principals(id) on delete cascade,
  vault_id      text not null references vaults(id) on delete cascade,
  permission    text not null check (permission in ('read', 'write', 'curate', 'admin')),
  granted_by    text references principals(id) on delete set null,
  granted_at    timestamptz not null default now(),
  primary key (principal_id, vault_id)
);
create index vault_grants_vault_idx on vault_grants (vault_id);

-- ---------------------------------------------------------------------------
-- Audit log: append-only. BRIN on time keeps the index tiny at any size.
-- ---------------------------------------------------------------------------
create table audit_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  principal_id  text,
  action        text not null,                        -- login.totp, page.read, admin.user.create, ...
  resource      text,
  outcome       text not null default 'ok' check (outcome in ('ok', 'denied', 'error')),
  ip            inet,
  user_agent    text,
  data          jsonb
);
create index audit_log_at_brin on audit_log using brin (at);
create index audit_log_principal_idx on audit_log (principal_id, at desc);
create index audit_log_action_idx on audit_log (action, at desc);
