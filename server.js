// server.js — Nexus Membership Bot (Stripe + Telegram)
// Requer: "type": "module" no package.json e deps: express, stripe, body-parser, node-fetch

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import fetch from "node-fetch";

/* ================== ENV VARS (Railway) ================== */
const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  GROUP_CHAT_ID,       // ex: -1003037084693
  PREMIUM_PRICE_ID,    // price_... (Premium)
  GENERIC_PRICE_ID,    // price_... (Generic)
  PORT,
} = process.env;

/* ================== SANITY CHECK ================== */
function mask(s, head = 5, tail = 5) {
  if (!s) return "";
  if (s.length <= head + tail) return "***";
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

console.log("== ENV CHECK ==");
console.log("GENERIC_PRICE_ID:", !!GENERIC_PRICE_ID ? "OK" : "MISSING");
console.log("PREMIUM_PRICE_ID:", !!PREMIUM_PRICE_ID ? "OK" : "MISSING");
console.log("STRIPE_SECRET_KEY:", !!STRIPE_SECRET_KEY ? "OK" : "MISSING");
console.log("STRIPE_WEBHOOK_SECRET:", !!STRIPE_WEBHOOK_SECRET ? "LOADED" : "MISSING");
console.log("TELEGRAM_BOT_TOKEN:", !!TELEGRAM_BOT_TOKEN ? "OK" : "MISSING");
console.log("GROUP_CHAT_ID:", !!GROUP_CHAT_ID ? "OK" : "MISSING");

if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GROUP_CHAT_ID) throw new Error("Missing GROUP_CHAT_ID");

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

/* ================== HEALTH ================== */
// simples “alive”
app.get("/", (_req, res) => res.send("OK"));

// checagem de envs (true/false; não expõe valores)
app.get("/env-check", (_req, res) => {
  res.json({
    STRIPE_SECRET_KEY: !!STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: !!STRIPE_WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: !!TELEGRAM_BOT_TOKEN,
    GROUP_CHAT_ID: !!GROUP_CHAT_ID,
    PREMIUM_PRICE_ID: !!PREMIUM_PRICE_ID,
    GENERIC_PRICE_ID: !!GENERIC_PRICE_ID,
  });
});

// teste direto no Telegram (confirma token/URL)
app.get("/whoami", async (_req, res) => {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`;
    console.log("[whoami] calling:", `https://api.telegram.org/bot${mask(TELEGRAM_BOT_TOKEN)}/getMe`);
    const r = await fetch(url);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* =========================================================
   IMPORTANTE: o webhook do Stripe precisa do RAW body!
   Portanto, defina-o ANTES do express.json()
   ========================================================= */
app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("⚠️  Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          // 1) tenta pegar o telegram_id da própria sessão
          let telegramId = session?.metadata?.telegram_id;

          // 2) se não existir, busca da assinatura (boa prática p/ subscription)
          if (!telegramId && session.subscription) {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            telegramId = sub?.metadata?.telegram_id;
          }

          if (!telegramId) {
            console.warn("No telegram_id in session/subscription metadata");
            return res.json({ received: true });
          }

          // identifica o plano (apenas texto amigável para a mensagem)
          let tierLabel = "Generic";
          const priceId =
            session?.line_items?.data?.[0]?.price?.id ||
            session?.metadata?.price_id ||
            null;

          if (priceId === PREMIUM_PRICE_ID) tierLabel = "Premium";
          if (priceId === GENERIC_PRICE_ID) tierLabel = "Generic";

          await sendInvite(telegramId, tierLabel);
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          // redundância: se assinar/atualizar fora do Checkout
          const sub = event.data.object;
          const telegramId = sub?.metadata?.telegram_id;
          if (telegramId && sub.status === "active") {
            await sendInvite(telegramId, "Subscription Active");
          }
          break;
        }

        default:
          // silencioso para não poluir os logs
          break;
      }

      res.json({ received: true });
    } catch (err) {
      console.error("Webhook handler error:", err);
      res.status(500).send("Webhook handler error");
    }
  }
);

/* ================== JSON PARA AS OUTRAS ROTAS ================== */
app.use(express.json());

/* ================== ROTA DE CHECKOUT ================== */
// body: { priceId, telegramId }
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, telegramId } = req.body;
    if (!priceId || !telegramId) {
      return res.status(400).json({ error: "Missing priceId or telegramId" });
    }

    // sessão de assinatura com metadata
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://t.me/NexusCommunityBRBot?start=ok",
      cancel_url: "https://t.me/NexusCommunityBRBot?start=cancel",
      // importante: gravar o telegram_id
      metadata: { telegram_id: String(telegramId), price_id: priceId },
      // E também gravar na subscription (melhor prática)
      subscription_data: {
        metadata: { telegram_id: String(telegramId), price_id: priceId },
      },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ================== FUNÇÕES TELEGRAM ================== */
async function sendInvite(telegramId, tierLabel) {
  // cria link de convite único/expira em 30min
  const inviteRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: GROUP_CHAT_ID,
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 1800, // +30 min
      }),
    }
  ).then((r) => r.json());

  const inviteLink = inviteRes?.result?.invite_link;
  if (!inviteLink) {
    console.error("Failed to create invite link:", inviteRes);
    return;
  }

  // envia DM para o usuário com o link
  const text =
    `✅ *${tierLabel}* ativado.\n` +
    `👉 Entre no grupo: ${inviteLink}\n\n` +
    `_Lembrete: membership digital não garante emprego._`;

  const sendRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramId,
        text,
        parse_mode: "Markdown",
      }),
    }
  ).then((r) => r.json());

  if (!sendRes.ok) {
    console.error("sendMessage error:", sendRes);
  }
}

/* ================== START ================== */
const port = Number(PORT) || 8080;
app.listen(port, () => {
  console.log(`server running on port ${port}`);
});
