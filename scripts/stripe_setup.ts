#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
/**
 * Create (or verify) the Stripe products and prices the plan catalog expects.
 *
 *   deno run --allow-env --allow-net --allow-read scripts/stripe_setup.ts
 *   deno run --allow-env --allow-net --allow-read scripts/stripe_setup.ts --dry-run
 *
 * Idempotent: a price whose lookup key already exists is left alone, because
 * Stripe prices are immutable and customers are subscribed to specific ones.
 * Changing what a tier costs means creating a *new* price and moving the
 * lookup key onto it — which is exactly what `--reprice` does.
 *
 * Reads STRIPE_SECRET_KEY from the environment or from .env.local.
 */

import { PLANS, PURCHASABLE_PLAN_IDS } from "../supabase/functions/_shared/plans.ts";

const API = "https://api.stripe.com/v1";

function loadKey(): string {
  const fromEnv = Deno.env.get("STRIPE_SECRET_KEY")?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = Deno.readTextFileSync(new URL("../.env.local", import.meta.url));
    const line = text.split("\n").find((l) => l.startsWith("STRIPE_SECRET_KEY="));
    const value = line?.slice("STRIPE_SECRET_KEY=".length).trim();
    if (value) return value;
  } catch { /* fall through to the error below */ }
  console.error("STRIPE_SECRET_KEY is not set, and .env.local has no usable value.");
  Deno.exit(1);
}

const KEY = loadKey();
const DRY_RUN = Deno.args.includes("--dry-run");
const REPRICE = Deno.args.includes("--reprice");

async function stripe(
  path: string,
  init?: { method?: string; form?: Record<string, string>; query?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) url.searchParams.set(k, v);

  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Basic ${btoa(`${KEY}:`)}`,
      ...(init?.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.form ? new URLSearchParams(init.form) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${path}: ${payload?.error?.message ?? response.status}`);
  }
  return payload;
}

async function findPrice(lookupKey: string) {
  const result = await stripe("/prices", {
    query: { "lookup_keys[0]": lookupKey, active: "true", limit: "1" },
  });
  return (result.data as Array<Record<string, unknown>>)[0];
}

async function findProduct(planId: string) {
  const result = await stripe("/products/search", {
    query: { query: `metadata['replymate_plan']:'${planId}'`, limit: "1" },
  });
  return (result.data as Array<Record<string, unknown>>)[0];
}

const live = !KEY.startsWith("sk_test_");
console.log(`Stripe mode: ${live ? "LIVE ⚠️" : "test"}`);
if (live && !DRY_RUN) {
  console.log("Refusing to write to a live account without --dry-run first. Re-run with:");
  console.log("  ALLOW_LIVE=1 deno run ... scripts/stripe_setup.ts");
  if (Deno.env.get("ALLOW_LIVE") !== "1") Deno.exit(1);
}

for (const planId of PURCHASABLE_PLAN_IDS) {
  const plan = PLANS[planId];
  console.log(`\n── ${plan.name} ──`);

  let product = await findProduct(planId);
  if (product) {
    console.log(`  product ${product.id} (exists)`);
  } else if (DRY_RUN) {
    console.log(`  product would be created: ${plan.name}`);
    product = { id: "prod_DRYRUN" };
  } else {
    product = await stripe("/products", {
      method: "POST",
      form: {
        name: `ReplyMate ${plan.name}`,
        description: plan.blurb,
        "metadata[replymate_plan]": planId,
      },
    });
    console.log(`  product ${product.id} (created)`);
  }

  for (const interval of ["month", "year"] as const) {
    const lookupKey = plan.lookupKeys![interval];
    const amount = interval === "year" ? plan.annualPrice! : plan.monthlyPrice!;
    const existing = await findPrice(lookupKey);

    if (existing && !REPRICE) {
      const cents = Number(existing.unit_amount);
      const matches = cents === amount * 100;
      console.log(
        `  ${lookupKey}: ${existing.id} $${cents / 100}/${interval} ` +
          (matches ? "(matches catalog)" : `⚠️  CATALOG SAYS $${amount} — run --reprice`),
      );
      continue;
    }

    if (DRY_RUN) {
      console.log(`  ${lookupKey}: would create $${amount}/${interval}`);
      continue;
    }

    if (existing && REPRICE) {
      // A lookup key can only point at one active price, so the old one has to
      // release it first. Existing subscribers stay on the old price until they
      // are explicitly migrated — Stripe never reprices anyone silently.
      await stripe(`/prices/${existing.id}`, { method: "POST", form: { lookup_key: "" } });
      console.log(`  ${lookupKey}: released from ${existing.id}`);
    }

    const price = await stripe("/prices", {
      method: "POST",
      form: {
        product: String(product.id),
        currency: "usd",
        unit_amount: String(amount * 100),
        "recurring[interval]": interval,
        lookup_key: lookupKey,
        transfer_lookup_key: "true",
        "metadata[replymate_plan]": planId,
      },
    });
    console.log(`  ${lookupKey}: ${price.id} $${amount}/${interval} (created)`);
  }
}

console.log(
  `\nDone.${DRY_RUN ? " (dry run — nothing was written)" : ""}\n` +
    "Next: point a webhook at <SUPABASE_URL>/functions/v1/v1-billing-webhook for\n" +
    "checkout.session.completed and customer.subscription.*, then put its signing\n" +
    "secret in STRIPE_WEBHOOK_SECRET.",
);
