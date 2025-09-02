// server.js — Nexus Membership Bot (Stripe + Telegram)
// (ESM) — não usa node-telegram-bot-api, não faz polling.

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import fetch from "node-fetch";

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  GROUP_CHAT_ID,        // ex: -1003037084693
  PREMIUM_PRICE_ID,     // ex: price_...
  GENERIC_PRICE_ID,     // ex: price_...
  PORT
} = process.env;

// ==== sanity check das envs (evita rodar quebrado) ====
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GROUP_CHAT_ID) throw new Error("Missing GROUP_CHAT_ID");
if (!PREMIUM_PRICE_ID) throw new Error("Missing PREMIUM_PRICE_ID");
if (!GENERIC_PRICE_ID) throw new Error("Missing GENERIC_PRICE_ID");

// Stripe SDK
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Express
const app = express();

// Healthcheck p/ Railway
app.get("/", (_req, res) => res.send("OK"));

// ====== WEBHOOK DO STRIPE (precisa vir ANTES do express.json) ======
app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️  Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const tg = session.metadata?.telegram_id;
          const priceId = session.metadata?.price_id;
          const tier =
            priceId === PREMIUM_PRICE_ID ? "Premium" : "Generic";

          if (!tg) {
            console.warn("No telegram_id in session.completed; ignoring.");
            break;
          }
          await sendInvite(tg, tier);
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const sub = event.data.object;
          const tg =
            sub.metadata?.telegram_id ||
            sub.customer_details?.metadata?.telegram_id ||
            sub.customer?.metadata?.telegram_id;

          const priceId = sub.items?.data?.[0]?.price?.id;
          const tier =
            priceId === PREMIUM_PRICE_ID ? "Premium" : "Generic";

          if (tg) {
            await sendInvite(tg, tier);
          } else {
            console.warn("Subscription event without telegram_id; ignoring.");
          }
          break;
        }

        case "customer.subscription.deleted": {
          // (opcional) aqui você poderia revogar acesso.
          break;
        }

        default:
          console.log("Unhandled event type:", event.type);
      }
    } catch (err) {
      console.error("Webhook handler error:", err);
      return res.status(500).send("handler error");
    }

    res.json({ received: true });
  }
);

// ====== JSON para demais rotas ======
app.use(express.json());

// Cria sessão de checkout (use isso para testes end-to-end)
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, telegramId } = req.body;
    if (!priceId || !telegramId) {
      return res.status(400).json({ error: "Missing priceId or telegramId" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://t.me/NexusCommunityBRBot?start=ok",
      cancel_url: "https://t.me/NexusCommunityBRBot?start=cancel",
      // metadados para chegar no webhook
      metadata: {
        telegram_id: String(telegramId),
        price_id: priceId
      },
      // garante que o telegram_id também vai para a subscription
      subscription_data: {
        metadata: { telegram_id: String(telegramId) }
      }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Rota de debug — checa o token do bot
app.get("/whoami", async (_req, res) => {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`
    );
    const j = await r.json();
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== helpers Telegram ======
async function createInviteLink() {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: GROUP_CHAT_ID,
          member_limit: 1,
          expire_date: Math.floor(Date.now() / 1000) + 1800 // 30 min
        })
      }
    );
    const j = await r.json();
    if (!j.ok) throw new Error(JSON.stringify(j));
    return j.result.invite_link;
  } catch (e) {
    console.error("createInviteLink error:", e);
    throw e;
  }
}

async function sendInvite(telegramId, tierLabel) {
  const invite = await createInviteLink();
  const text = `✅ *${tierLabel}* activated.\nJoin the group: ${invite}\n\nReminder: digital membership does not guarantee employment.`;

  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramId,
          text,
          parse_mode: "Markdown"
        })
      }
    );
    const j = await r.json();
    if (!j.ok) console.error("sendMessage failed:", j);
    else console.log("Invite sent to", telegramId);
  } catch (e) {
    console.error("sendMessage error:", e);
  }
}

// Start
const port = Number(PORT) || 8080;
app.listen(port, () => {
  console.log("server running on port", port);
});
