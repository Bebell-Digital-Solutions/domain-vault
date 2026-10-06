-- ============================================================================
-- Domain Vault — a Free tier below Personal
--
-- Personal is now a paid plan (USD 29 / year), so an account that has not
-- paid needs a tier of its own. Whether unpaid accounts get Free or keep
-- Personal is an admin setting (billing_config.unpaid_plan, next migration).
--
-- On its own in this file: Postgres cannot use a new enum value inside the
-- transaction that adds it.
-- ============================================================================

alter type public.plan_tier add value if not exists 'Free' before 'Personal';
