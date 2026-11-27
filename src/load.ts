// Loads data/*.csv into Supabase. Re-runnable: accounts are reused and rows are upserted.
//   npm run load
// Needs SUPABASE_SECRET_KEY and SUPABASE_DB_URL in .env.local (never committed).
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { parse } from "csv-parse/sync";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
if (!url || !secretKey || !dbUrl) {
  throw new Error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_DB_URL in .env.local");
}

type Row = Record<string, string>;
const readCsv = (path: string): Row[] => parse(readFileSync(path), { columns: true, skip_empty_lines: true });

const bookings = readCsv("data/airbnb_guest_bookings_aug_nov_2026.csv");
const refunds = readCsv("data/airbnb_guest_refund_requests_sep_nov_2026.csv");

const guestEmails = Array.from({ length: 40 }, (_, i) => `guest${String(i + 1).padStart(2, "0")}@example.com`);
const listingIds = Array.from({ length: 60 }, (_, i) => `LST-${2001 + i}`);

// ---- Validate before touching the database -------------------------------
const fail = (msg: string) => { throw new Error(`Input check failed: ${msg}`); };
if (bookings.length !== 120) fail(`expected 120 bookings, got ${bookings.length}`);
if (refunds.length !== 50) fail(`expected 50 refund requests, got ${refunds.length}`);
const known = new Set(guestEmails);
for (const b of bookings) if (!known.has(b.guest_user_email)) fail(`unknown booking email ${b.guest_user_email}`);
for (const r of refunds) if (!known.has(r.requester_email)) fail(`unknown requester email ${r.requester_email}`);

const listings = new Map<string, { title: string; host: string }>();
for (const b of bookings) {
  const prev = listings.get(b.listing_id);
  if (prev && (prev.title !== b.listing_title || prev.host !== b.host_name)) {
    fail(`listing ${b.listing_id} has conflicting title/host`);
  }
  listings.set(b.listing_id, { title: b.listing_title, host: b.host_name });
}
for (const id of listingIds) if (!listings.has(id)) fail(`missing listing ${id}`);
if (listings.size !== 60) fail(`expected 60 listings, got ${listings.size}`);

// ---- Guest accounts --------------------------------------------------------
const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

const existing = new Map<string, string>();
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  for (const u of data.users) if (u.email) existing.set(u.email.toLowerCase(), u.id);
  if (data.users.length < 1000) break;
}

const userIds = new Map<string, string>();
let created = 0;
for (const email of guestEmails) {
  let id = existing.get(email);
  if (!id) {
    // No password: these accounts exist to own data, not to be logged into with a guessable secret.
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { guest: true },
    });
    if (error) throw error;
    id = data.user.id;
    created++;
  }
  userIds.set(email, id);
}
console.log(`Guest accounts: ${created} created, ${guestEmails.length - created} already existed`);

// ---- Schema + data (one transaction) --------------------------------------
const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  await db.query("begin");
  await db.query(readFileSync("supabase/schema.sql", "utf8"));

  for (const email of guestEmails) {
    await db.query(
      `insert into public.guests (user_id, email) values ($1, $2)
       on conflict (user_id) do update set email = excluded.email`,
      [userIds.get(email), email],
    );
  }

  for (const [id, l] of listings) {
    await db.query(
      `insert into public.listings (listing_id, title, host_name) values ($1, $2, $3)
       on conflict (listing_id) do update set title = excluded.title, host_name = excluded.host_name`,
      [id, l.title, l.host],
    );
  }

  // All text goes in as bound parameters: stored verbatim, never interpreted.
  for (const b of bookings) {
    await db.query(
      `insert into public.bookings (booking_id, user_id, guest_user_email, guest_name, listing_id,
         listing_description, booked_at, check_in, check_out, nights, total_paid,
         cancellation_policy, booking_status, amount_already_refunded)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (booking_id) do update set
         user_id = excluded.user_id, guest_user_email = excluded.guest_user_email,
         guest_name = excluded.guest_name, listing_id = excluded.listing_id,
         listing_description = excluded.listing_description, booked_at = excluded.booked_at,
         check_in = excluded.check_in, check_out = excluded.check_out, nights = excluded.nights,
         total_paid = excluded.total_paid, cancellation_policy = excluded.cancellation_policy,
         booking_status = excluded.booking_status,
         amount_already_refunded = excluded.amount_already_refunded`,
      [
        b.booking_id, userIds.get(b.guest_user_email), b.guest_user_email, b.guest_name, b.listing_id,
        b.listing_description, b.booked_at, b.check_in, b.check_out, b.nights, b.total_paid,
        b.cancellation_policy, b.booking_status, b.amount_already_refunded,
      ],
    );
  }

  // Ownership comes from requester_email only. booking_id is stored as a claim.
  for (const r of refunds) {
    await db.query(
      `insert into public.refund_requests (request_id, requester_user_id, requester_email,
         claimed_booking_id, submitted_at, request_reason, requested_amount, message_text, channel)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (request_id) do update set
         requester_user_id = excluded.requester_user_id, requester_email = excluded.requester_email,
         claimed_booking_id = excluded.claimed_booking_id, submitted_at = excluded.submitted_at,
         request_reason = excluded.request_reason, requested_amount = excluded.requested_amount,
         message_text = excluded.message_text, channel = excluded.channel`,
      [
        r.request_id, userIds.get(r.requester_email), r.requester_email, r.booking_id, r.submitted_at,
        r.request_reason, r.requested_amount, r.message_text, r.channel,
      ],
    );
  }

  await db.query("commit");
} catch (e) {
  await db.query("rollback");
  throw e;
}

// ---- Verify ----------------------------------------------------------------
const counts = await db.query(`
  select 'auth.users (guest accounts)' as table_name,
         (select count(*) from auth.users where email = any($1)) as rows
  union all select 'public.guests',          (select count(*) from public.guests)
  union all select 'public.listings',        (select count(*) from public.listings)
  union all select 'public.bookings',        (select count(*) from public.bookings)
  union all select 'public.refund_requests', (select count(*) from public.refund_requests)`,
  [guestEmails],
);
console.table(counts.rows.map((r) => ({ table: r.table_name, rows: Number(r.rows) })));

const own = await db.query(
  `select count(*) filter (where requester_owns_booking) as owned,
          count(*) filter (where not requester_owns_booking) as not_owned
   from public.refund_request_ownership`,
);
console.log(`Refund claims where requester owns the booking: ${own.rows[0].owned}; not owned: ${own.rows[0].not_owned}`);

const verbatim = await db.query(
  "select booking_id, listing_description from public.bookings",
);
const stored = new Map(verbatim.rows.map((r) => [r.booking_id, r.listing_description]));
const mismatches = bookings.filter((b) => stored.get(b.booking_id) !== b.listing_description).length;
console.log(`Descriptions stored byte-for-byte: ${bookings.length - mismatches}/${bookings.length}`);

await db.end();
