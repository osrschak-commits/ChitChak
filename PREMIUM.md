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

**Not yet chosen.** The realistic options for a solo developer:

- **Stripe** — best API, lowest fees. You are the merchant of record, so VAT
  registration and returns in every country you sell to are yours. Stripe Tax
  calculates; it does not file.
- **Paddle / Lemon Squeezy** — they become the legal seller and handle VAT
  entirely. Higher fees. This is what most one-person operations selling digital
  goods to consumers actually use, and the current recommendation.

Discord takes cards directly through Stripe and goes through Apple and Google on
mobile, because the app stores require it. That works for them because they have
a finance team; the part that does not transfer is the tax filing, not the code.

## Statuses

`none` · `active` · `past_due` · `cancelled`

`active` is not trusted on its own — a period that has run out is not active
however the row is labelled, because a cancellation webhook can be late, lost,
or never sent. The failure should be a subscription lapsing, not one lasting
forever.
