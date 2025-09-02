// server.js — Nexus Community: Stripe (checkout+webhook) + Telegram (convite automático)

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import fetch from "node-fetch";
import cors from "cors";
import TelegramBot from "node-telegram-bot-api";

// ===== ENV VARS (defina todas no Railway → Service Variables) =====
const {
  STRIPE_SECRET_KEY,        // sk_live_... (ou sk_test_... se estiver testando)
  STRIPE_WEBHOOK_SECRET,    // whsec_... do endpoint ATUAL (modo correspondente: live ou test)
  TELEGRAM_BOT_TOKEN,       // token do BotFather
  GROUP_CHAT_ID,            // ex.: -1003037084693
  PREMIUM_PRICE_ID,         // price_... (Premium)
  GENERIC_PRICE_ID,         // price_... (Generic)
  SERVER_URL,               // opcional; se vazio, usamos o padrão Railway
  PORT
} = process.env;

// Validações mínimas (se faltar algo crítico, crasha com mensagem clara)
if (!STRIPE_SECRET_KEY)       throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET)   throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!TELEGRAM_BOT_TOKEN)      throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GROUP_CHAT_ID)           throw new Error("Missing GROUP_CHAT_ID");
if (!PREMIUM_PRICE_ID)        console.warn("⚠️ Missing PREMIUM_PRICE_ID");
if (!GENERIC_PRICE_ID)        console.warn("⚠️ Missing GENERIC_PRICE_ID");

const BASE_URL = SERVER_URL || "https://nexus-membership-bot-production.up.railway.app";

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// Habilita CORS para permitir chamada do HTML estático/local se quiser
app.use(cors());

// ============== Helpers (Telegram + Stripe) ==============
const sendInvite = async (telegramId, tierLabel) => {
  try {
    // Cria link único que expira em 30 min
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

const getTierFromPrice = (priceId) => {
  if (priceId === PREMIUM_PRICE_ID) return "Premium Plan (€24.99/month)";
  if (priceId === GENERIC_PRICE_ID) return "Generic Plan (€9.99/month)";
  return "Membership";
};

const fetchSubscription = async (subId) => {
  if (!subId) return null;
  try {
    // expand para ler o price que foi comprado
    return await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
  } catch (e) {
    console.error("Stripe fetchSubscription error:", e?.message || e);
    return null;
  }
};

// ============== Healthcheck (rápido para ver se app está de pé) ==============
app.get("/", (_req, res) => res.send("OK"));

// ============== WEBHOOK Stripe (tem que ficar ANTES do express.json!) ==============
app.post("/stripe-webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    switch (event.type) {
      // Ativação inicial (via Checkout)
      case "checkout.session.completed": {
        const session = event.data.object; // CheckoutSession
        const telegramId = session.metadata?.telegram_id;
        // garantimos o price vendo a subscription (o session nem sempre traz line_items)
        const sub = await fetchSubscription(session.subscription);
        const priceId = sub?.items?.data?.[0]?.price?.id;
        const tierLabel = getTierFromPrice(priceId);

        if (telegramId) await sendInvite(telegramId, tierLabel);
        else console.warn("No telegram_id in session.metadata");
        break;
      }

      // Renovação mensal
      case "invoice.payment_succeeded": {
        const inv = event.data.object; // Invoice
        const sub = await fetchSubscription(inv.subscription);
        const telegramId = sub?.metadata?.telegram_id || inv.metadata?.telegram_id;
        const priceId = sub?.items?.data?.[0]?.price?.id;
        const tierLabel = getTierFromPrice(priceId);
        console.log(`Renewal OK → tg:${telegramId || "-"} | ${tierLabel}`);
        break;
      }

      // Cancelamento/expiração
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

// ============== JSON parser para as demais rotas (depois do webhook!) ==============
app.use(express.json());

// ============== Criar sessão de Checkout (usa metadata + subscription_data.metadata) ==============
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

      // Session metadata: usado no checkout.session.completed
      metadata: { telegram_id: String(telegramId) },

      // Propaga para Subscription/Invoices para renovações/cancelamentos
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

// ============== Telegram Bot — /start com botões que disparam o Checkout ==============
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// /start → mostra os planos
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const keyboard = {
    inline_keyboard: [
      [{ text: "Generic €9.99", callback_data: "buy_generic" }],
      [{ text: "Premium €24.99", callback_data: "buy_premium" }]
    ]
  };

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "Choose your plan to generate the checkout:",
      reply_markup: keyboard
    })
  });
});

// Clique nos botões → cria sessão de checkout e envia link
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  let priceId = null;
  if (data === "buy_generic") priceId = GENERIC_PRICE_ID;
  if (data === "buy_premium") priceId = PREMIUM_PRICE_ID;

  if (!priceId) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "Invalid plan. Try /start again." })
    });
    return;
  }

  try {
    const r = await fetch(`${BASE_URL}/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceId, telegramId: chatId })
    });
    const json = await r.json();
    if (!r.ok || !json?.url) throw new Error(json?.error || "Failed to create checkout.");

    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✅ Checkout created.\nClick to pay: ${json.url}`
      })
    });
  } catch (e) {
    console.error("callback_query error:", e);
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Error creating checkout. Try /start again."
      })
    });
  }
});

// ============== Start server (necessário no Railway) ==============
const listenPort = PORT || 3000;
app.listen(listenPort, () => {
  console.log(`🚀 Server running on port ${listenPort}`);
});
