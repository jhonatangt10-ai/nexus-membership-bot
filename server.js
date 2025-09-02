// server.js — Nexus Membership Bot (Stripe + Telegram)
// package.json precisa ter: "type": "module" e deps: express, stripe, body-parser, node-fetch

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import fetch from "node-fetch";

// ===== ENV VARS (configure no Railway) =====
const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  GROUP_CHAT_ID,
  PREMIUM_PRICE_ID,
  GENERIC_PRICE_ID,
  PORT
} = process.env;

// Debug imediato antes de qualquer throw
console.log("=== ENV CHECK (STARTUP) ===");
console.log("GENERIC_PRICE_ID:", GENERIC_PRICE_ID);
console.log("PREMIUM_PRICE_ID:", PREMIUM_PRICE_ID);
console.log("STRIPE_SECRET_KEY:", STRIPE_SECRET_KEY ? "LOADED" : "MISSING");
console.log("STRIPE_WEBHOOK_SECRET:", STRIPE_WEBHOOK_SECRET ? "LOADED" : "MISSING");
console.log("TELEGRAM_BOT_TOKEN:", TELEGRAM_BOT_TOKEN ? "LOADED" : "MISSING");
console.log("GROUP_CHAT_ID:", GROUP_CHAT_ID);
console.log("===========================");

// 🔎 Debug para confirmar variáveis carregadas no Railway
console.log("=== ENV CHECK ===");
console.log("GENERIC_PRICE_ID:", GENERIC_PRICE_ID ? "OK" : "MISSING");
console.log("PREMIUM_PRICE_ID:", PREMIUM_PRICE_ID ? "OK" : "MISSING");
console.log("STRIPE_SECRET_KEY:", STRIPE_SECRET_KEY ? "OK" : "MISSING");
console.log("STRIPE_WEBHOOK_SECRET:", STRIPE_WEBHOOK_SECRET ? "OK" : "MISSING");
console.log("TELEGRAM_BOT_TOKEN:", TELEGRAM_BOT_TOKEN ? "OK" : "MISSING");
console.log("GROUP_CHAT_ID:", GROUP_CHAT_ID ? "OK" : "MISSING");
console.log("=================");

// Proteção extra
if (!STRIPE_SECRET_KEY) throw new Error("❌ Missing STRIPE_SECRET_KEY");
const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// Healthcheck — útil pro Railway
app.get("/", (_req, res) => res.send("OK"));

// ⚠️ Coloque o WEBHOOK ANTES do express.json()!
// O Stripe precisa do corpo RAW para validar a assinatura.
app.post("/stripe-webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  // ===== Helpers internos =====
  const getTierFromPrice = (priceId) => {
    if (priceId === PREMIUM_PRICE_ID) return "Premium Plan (€24.99/month)";
    if (priceId === GENERIC_PRICE_ID) return "Generic Plan (€9.99/month)";
    return "Membership";
  };

  const fetchSubscription = async (subId) => {
    if (!subId) return null;
    try {
      // expand pra saber qual price foi comprado
      return await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
    } catch (e) {
      console.error("Stripe fetchSubscription error:", e?.message || e);
      return null;
    }
  };

  const sendInvite = async (telegramId, tierLabel) => {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: GROUP_CHAT_ID,
          member_limit: 1,
          expire_date: Math.floor(Date.now() / 1000) + 1800 // 30 min
        })
      }).then(r => r.json());

      const invite = r?.result?.invite_link;
      if (!invite) {
        console.error("No invite_link from Telegram:", r);
        return;
      }

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramId,
          text: `✅ ${tierLabel} activated.\nJoin the group: ${invite}\n\n*Reminder:* digital membership; does not guarantee employment.`,
          parse_mode: "Markdown"
        })
      });
    } catch (e) {
      console.error("Telegram sendInvite error:", e);
    }
  };

  const kickFromGroup = async (telegramId) => {
    try {
      // ban + unban = “kick” e permite voltar no futuro
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
    } catch (e) {
      console.error("Telegram kick error:", e);
    }
  };

  try {
    // ===== Processa os eventos do Stripe =====
    switch (event.type) {
      // Ativação inicial via Checkout
      case "checkout.session.completed": {
        const session = event.data.object; // CheckoutSession
        const telegramId = session.metadata?.telegram_id;
        const sub = await fetchSubscription(session.subscription);
        const priceId = sub?.items?.data?.[0]?.price?.id;
        const tierLabel = getTierFromPrice(priceId);

        if (telegramId) await sendInvite(telegramId, tierLabel);
        else console.warn("No telegram_id in session.metadata");
        break;
      }

      // Renovação mensal (apenas log/auditoria; convite não é necessário)
      case "invoice.payment_succeeded": {
        const inv = event.data.object; // Invoice
        const sub = await fetchSubscription(inv.subscription);
        const telegramId = sub?.metadata?.telegram_id || inv.metadata?.telegram_id;
        const priceId = sub?.items?.data?.[0]?.price?.id;
        const tierLabel = getTierFromPrice(priceId);

        console.log(`Renewal OK → tg:${telegramId || "-"} | ${tierLabel}`);
        break;
      }

      // Cancelamento/expiração: remover do grupo
      case "customer.subscription.deleted": {
        const sub = event.data.object; // Subscription
        const telegramId = sub?.metadata?.telegram_id;
        if (telegramId) await kickFromGroup(telegramId);
        else console.warn("No telegram_id on subscription.metadata (delete)");
        break;
      }

      default:
        console.log(`Unhandled event: ${event.type}`);
    }

    res.json({ received: true });
  } catch (e) {
    console.error("Webhook handler error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// Agora sim liberamos o JSON parser para as demais rotas
app.use(express.json());

// ====== Criar sessão de Checkout ======
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
      cancel_url:  "https://t.me/NexusCommunityBRBot?start=cancel",

      // 1) Session metadata (usado no checkout.session.completed)
      metadata: { telegram_id: String(telegramId) },

      // 2) Propaga pra Subscription/Invoices (renovações/cancelamentos)
      subscription_data: {
        metadata: { telegram_id: String(telegramId) }
      }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e?.message || e);
    res.status(500).json({ error: e.message });
  }
});

// ====== Start server (necessário no Railway) ======
const listenPort = PORT || 3000;
app.listen(listenPort, () => {
  console.log(`🚀 Server running on port ${listenPort}`);
});
