import express from "express";
import Stripe from "stripe";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  GROUP_CHAT_ID,
  PREMIUM_PRICE_ID,
  GENERIC_PRICE_ID
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);

app.get("/", (req, res) => res.send("OK"));

app.use(express.json());

// criar checkout
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, telegramId } = req.body;
    if (!priceId || !telegramId) return res.status(400).json({ error: "Missing priceId or telegramId" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://t.me/NexusCommunityBRBot?start=ok",
      cancel_url: "https://t.me/NexusCommunityBRBot?start=cancel",
      metadata: { telegram_id: String(telegramId) }
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// webhook
app.post("/stripe-webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  const sendInvite = async (telegramId, tierLabel) => {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: GROUP_CHAT_ID,
        member_limit: 1,
        expire_date: Math.floor(Date.now()/1000) + 1800
      })
    }).then(r => r.json());

    const invite = r?.result?.invite_link;
    if (invite) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramId,
          text: `✅ ${tierLabel} activated.\nJoin the group: ${invite}\n\nReminder: digital membership; does not guarantee employment.`,
          parse_mode: "Markdown"
        })
      });
    }
  };

  if (event.type === "invoice.payment_succeeded") {
    const inv = event.data.object;
    const telegramId = inv.metadata?.telegram_id;
    const priceId = inv.lines?.data?.[0]?.price?.id;
    if (telegramId && priceId) {
      const tierLabel =
        priceId === PREMIUM_PRICE_ID ? "Premium plan (€24.99/month)" :
        priceId === GENERIC_PRICE_ID ? "Generic plan (€9.99/month)" :
        "Membership";
      await sendInvite(telegramId, tierLabel);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const telegramId = sub.metadata?.telegram_id;
    if (telegramId) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/banChatMember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: GROUP_CHAT_ID, user_id: telegramId })
      });
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/unbanChatMember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: GROUP_CHAT_ID, user_id: telegramId })
      });
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`listening on ${PORT}`));
