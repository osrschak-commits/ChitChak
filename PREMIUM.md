# Premium

Two things: a subscription, and a currency called **chak keys**. A subscription
includes 2 keys each period; more can be bought outright in the store.

## What keys can and cannot buy

Keys buy decoration. Nothing else.

Nothing bought with money changes what somebody can do, what they can see, who
they can talk to, or how loud they are. The moment money buys permission,
moderation becomes a pricing question and every argument about a ban becomes an
argument about a refund. Server upgrades, when they come, are limits on things
the server pays for — upload size, emoji count, stream quality — never authority
over people.

## The tier needs a name

Working name: **Brass**.

The accent colour already means "this is you" everywhere in the app, brass is
the metal studio hardware is trimmed with, and it sits naturally beside keys.
"A Brass member", "Brass renews on the 3rd". Not settled — replace it here and
in the client copy if something better turns up.

## Why a ledger and not a balance

`key_ledger` records every movement; a balance is its sum. A column would answer
"how many do I have" and nothing else. The question people actually ask is
"where did my keys go", usually because they think something has gone wrong, and
only a ledger can answer that.

Every entry carries a `reference`, and the unique index on
`(user_id, reason, reference)` is what makes payment idempotent: a webhook
delivered three times pays out once, with no coordination and no lock.

## Spending is serializable, and retried once

Reading a balance and then writing outside a transaction lets somebody buy two
things with the keys for one by clicking twice. Here the two requests come from
the same person, so that is not a rare race — it is the obvious way to try it on.

`spend` reads and writes inside one `serializable` transaction. Postgres raises
40001 when it cannot order two of them, and that is retried once: the retry sees
the committed balance and either succeeds or refuses with a real reason.
Without the retry the loser gets "Something went wrong", which reads as a broken
app rather than as "you cannot afford that".

## The payment provider is behind one function

`subscriptions.applyFromProvider` is the entire seam. A provider's webhook
resolves to: this person is in this state until this date. Nothing above that
line knows which provider it is.

**Paddle**, because Paddle is merchant of record: they are the legal seller, so
VAT in every country a customer lives in is theirs to calculate, collect and
file. Stripe has a better API and lower fees, but leaves all of that with you,
and for a one-person operation the filing is the expensive part rather than the
integration.

Discord takes cards directly through Stripe and goes through Apple and Google on
mobile, because the app stores require it. That works for them because they have
a finance team; the part that does not transfer is the tax filing, not the code.

### Setting it up

Nothing below is in the repository, and the server runs without any of it — the
shop shows, keys already granted still spend, and only buying is unavailable.

1. A Paddle account, and **Sandbox** first. Everything works there with test
   cards; nothing needs a real bank account until you go live.
2. In the catalogue, create the products and prices:
   - a recurring monthly price for the subscription
   - one-off prices for key packs (5 and 15)
3. **Notifications** → a destination pointing at
   `https://api.chitchak.com/api/webhooks/paddle`, subscribed to
   `subscription.*` and `transaction.completed`. Copy the secret key it gives
   you.
4. Put them in `.env.production` on the server:

   ```
   PADDLE_ENV=production          # or sandbox while testing
   PADDLE_API_KEY=...
   PADDLE_WEBHOOK_SECRET=...
   PADDLE_PRICE_SUBSCRIPTION=pri_...
   PADDLE_PRICE_KEYS_5=pri_...
   PADDLE_PRICE_KEYS_15=pri_...
   ```

5. Redeploy. `GET /api/premium/store` starts reporting `open: true` and the buy
   buttons appear on their own.

Going live also needs Paddle to approve the account — they check what is being
sold, which for a chat app's cosmetics is straightforward, but it is a review
with a wait rather than a switch.

### The webhook is the authentication

There is no session on a webhook, so its signature is the only thing standing
between the internet and free keys. It is checked against the **raw bytes**,
which is why that route has its own body parser: `JSON.stringify(JSON.parse(x))`
is rarely `x`, and re-serialising would fail every signature for reasons that
look like a wrong secret.

Compared with `timingSafeEqual`, and the timestamp is checked as well as the
signature — five seconds, per Paddle's guidance. Without the age check, one
captured request could be replayed forever, and a replayed renewal is free keys.

Verified by trying: no signature, a wrong secret, a minute-old timestamp, a body
edited after signing, a malformed header, and a truncated signature. All six
refused, and nothing reached the ledger.

## Statuses

`none` · `active` · `past_due` · `cancelled`

`active` is not trusted on its own — a period that has run out is not active
however the row is labelled, because a cancellation webhook can be late, lost,
or never sent. The failure should be a subscription lapsing, not one lasting
forever.
