# Takeout key issuer

Sale → signed key → email, with no server to babysit. Runs on Cloudflare Workers (free tier is plenty).

## Deploy once

```
cd worker/takeout
npx wrangler login
npx wrangler kv namespace create KEYS        # paste the id into wrangler.toml
npx wrangler secret put TAKEOUT_PRIV         # the private key (same one scripts/takeout-key.js uses)
npx wrangler secret put ADMIN_TOKEN          # anything long and random
npx wrangler secret put RESEND_API_KEY       # resend.com → API key (verify the sending domain first, or use onboarding@resend.dev to test)
npx wrangler secret put LS_SIGNING_SECRET    # Lemon Squeezy → Settings → Webhooks → signing secret
npx wrangler secret put KOFI_TOKEN           # Ko-fi → Webhooks → verification token
npx wrangler deploy                          # prints https://takeout.cobander.com
```

## Hook the stores up

- Lemon Squeezy: Settings → Webhooks → URL `https://takeout.cobander.com/webhook/lemonsqueezy`, event `order_created`. Add a checkout
  custom field named `band` ("Band name") so the key carries it.
- Ko-fi: Settings → Webhooks → URL `https://takeout.cobander.com/webhook/kofi`. The buyer's message is used as the band name.

Tier is by amount: ≥ $60 Roadie, ≥ $25 Groupie; anything under $25 is a tip (no key). Ko-fi: the message is "Band name (bandmate, bandmate…)"; Lemon Squeezy: checkout custom fields `band` and `members`.

## By hand

```
curl -X POST https://takeout.cobander.com/issue -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"band":"Never a Doubt","email":"someone@x.y","cents":2500}'
curl https://takeout.cobander.com/lookup?email=someone@x.y -H "authorization: Bearer $ADMIN_TOKEN"
curl -X POST https://takeout.cobander.com/resend?email=someone@x.y -H "authorization: Bearer $ADMIN_TOKEN"
```

Or without the Worker at all: `node scripts/takeout-key.js "Band Name"` and paste the key into an email.
