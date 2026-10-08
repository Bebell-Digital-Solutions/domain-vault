-- ============================================================================
-- Domain Vault — pay first, sign up after
--
-- The lifetime-deal page sends buyers straight to PayPal, before they have an
-- account, so the payment carries no account email and lands "unmatched".
-- It must not be handed to whoever later registers with the same email:
-- sign-up emails are not verified, so anyone could register a payer's
-- address and take their plan.
--
-- Instead the webhook emails an activation link to the payer's PayPal email
-- — an address PayPal has verified. Whoever holds that link may attach the
-- payment to the account they sign up with or log into. The token is 256
-- random bits, single-use and expires after 30 days.
-- ============================================================================

create table if not exists public.purchase_claims (
  token      text primary key,
  txn_id     text,
  subscr_id  text,
  email      text not null,
  plan       public.plan_tier,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  claimed_at timestamptz,
  claimed_by uuid references auth.users (id) on delete set null,
  constraint purchase_claims_token_shape check (token ~ '^[A-Za-z0-9_-]{43}$'),
  constraint purchase_claims_target check (txn_id is not null or subscr_id is not null)
);

create index if not exists purchase_claims_txn_idx on public.purchase_claims (txn_id);
create index if not exists purchase_claims_subscr_idx on public.purchase_claims (subscr_id);

-- Service role only (api and billing-webhook functions).
alter table public.purchase_claims enable row level security;
revoke all on public.purchase_claims from anon, authenticated;

-- ---------------------------------------------------------------------------
-- claim_purchase — attach an unmatched payment (or subscription) to a user.
--
-- Raises if the token is unknown, used or expired. Subscription payments
-- recorded as unmatched never got an end date, so they are given one here
-- (a year after the payment, plus grace), as the webhook would have.
-- Returns the user's plan afterwards; a paid plan also activates a pending
-- account (recompute_plan).
-- ---------------------------------------------------------------------------
create or replace function public.claim_purchase(p_token text, p_user uuid)
returns public.plan_tier
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim public.purchase_claims%rowtype;
  v_grace integer;
begin
  select * into v_claim from public.purchase_claims
   where token = p_token
   for update;

  if not found or v_claim.claimed_at is not null or v_claim.expires_at <= now() then
    raise exception 'activation link is invalid, already used or expired' using errcode = 'P0002';
  end if;

  select grace_days into v_grace from public.billing_config where id;

  if v_claim.txn_id is not null then
    update public.purchases
       set user_id = p_user,
           status  = 'completed',
           paid_until = case when kind = 'subscription'
                             then created_at + interval '1 year' + make_interval(days => coalesce(v_grace, 3))
                             else paid_until end,
           reason  = concat_ws('; ', reason, 'claimed by activation link')
     where txn_id = v_claim.txn_id and status = 'unmatched';
  end if;

  if v_claim.subscr_id is not null then
    update public.subscriptions
       set user_id = p_user, status = 'active', reason = concat_ws('; ', reason, 'claimed by activation link')
     where subscr_id = v_claim.subscr_id and status = 'unmatched';
    update public.purchases
       set user_id = p_user,
           status  = 'completed',
           paid_until = created_at + interval '1 year' + make_interval(days => coalesce(v_grace, 3)),
           reason  = concat_ws('; ', reason, 'claimed by activation link')
     where subscr_id = v_claim.subscr_id and status = 'unmatched';
  end if;

  update public.purchase_claims set claimed_at = now(), claimed_by = p_user where token = p_token;
  return public.recompute_plan(p_user);
end;
$$;

revoke all on function public.claim_purchase(text, uuid) from public, anon, authenticated;
