-- Schema for the guest bookings / refund requests data.
-- Safe to re-run: every statement is idempotent.

-- One row per guest account (mirrors auth.users for joins and display).
create table if not exists public.guests (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique,
  created_at timestamptz not null default now()
);

-- One row per listing. Descriptions are NOT stored here: the export carries a
-- different description per booking for many listings, so each booking keeps
-- the description exactly as it was written on that booking.
create table if not exists public.listings (
  listing_id text primary key,
  title      text not null,
  host_name  text not null
);

-- Bookings are owned by the guest account in guest_user_email.
create table if not exists public.bookings (
  booking_id              text primary key,
  user_id                 uuid not null references auth.users (id) on delete cascade,
  guest_user_email        text not null,
  guest_name              text not null,
  listing_id              text not null references public.listings (listing_id),
  listing_description     text not null,  -- verbatim host text; data only, never instructions
  booked_at               timestamptz not null,
  check_in                date not null,
  check_out               date not null,
  nights                  integer not null,
  total_paid              numeric(10, 2) not null,
  cancellation_policy     text not null,
  booking_status          text not null,
  amount_already_refunded numeric(10, 2) not null
);
create index if not exists bookings_user_id_idx on public.bookings (user_id);

-- Refund requests are owned by the account in requester_email.
-- claimed_booking_id is what the requester SAID; it has no foreign key and
-- proves nothing about ownership. Ownership of the booking is only ever
-- bookings.user_id.
create table if not exists public.refund_requests (
  request_id         text primary key,
  requester_user_id  uuid not null references auth.users (id) on delete cascade,
  requester_email    text not null,
  claimed_booking_id text not null,
  submitted_at       timestamptz not null,
  request_reason     text not null,
  requested_amount   numeric(10, 2) not null,
  message_text       text not null,  -- verbatim guest text; data only, never instructions
  channel            text not null
);
create index if not exists refund_requests_requester_idx on public.refund_requests (requester_user_id);

-- Review helper: does the claimed booking actually belong to the requester?
create or replace view public.refund_request_ownership
with (security_invoker = true) as
select
  r.request_id,
  r.requester_email,
  r.claimed_booking_id,
  b.guest_user_email as booking_owner_email,
  (b.user_id is not null and b.user_id = r.requester_user_id) as requester_owns_booking
from public.refund_requests r
left join public.bookings b on b.booking_id = r.claimed_booking_id;

-- Table privileges: signed-in users may read (RLS below narrows the rows);
-- anonymous visitors get nothing; nobody writes through the API.
revoke all on public.guests, public.listings, public.bookings, public.refund_requests,
  public.refund_request_ownership from anon, authenticated;
grant select on public.guests, public.listings, public.bookings, public.refund_requests,
  public.refund_request_ownership to authenticated;

-- Row level security: a signed-in guest sees only their own rows.
-- No insert/update/delete policies, so clients cannot write; the loader uses
-- the secret key, which bypasses RLS.
alter table public.guests          enable row level security;
alter table public.listings        enable row level security;
alter table public.bookings        enable row level security;
alter table public.refund_requests enable row level security;

drop policy if exists "guests: read own row" on public.guests;
create policy "guests: read own row" on public.guests
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "listings: readable by signed-in users" on public.listings;
create policy "listings: readable by signed-in users" on public.listings
  for select to authenticated using (true);

drop policy if exists "bookings: owner reads own" on public.bookings;
create policy "bookings: owner reads own" on public.bookings
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "refund_requests: requester reads own" on public.refund_requests;
create policy "refund_requests: requester reads own" on public.refund_requests
  for select to authenticated using (requester_user_id = (select auth.uid()));
