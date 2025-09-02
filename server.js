// server.js — Nexus Membership Bot (Stripe + Telegram)
// package.json precisa ter "type": "module" e deps: express, stripe, body-parser, node-fetch

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import fetch from "node-fetch";

// ===== ENV VARS (configure no Railway) =====
const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  GROUP_CHAT_ID,      // ex: -1003037084693
  PREMIUM_PRICE_ID,   // price_... (Premium)
  GENERIC_PRICE_ID,   // price_... (Generic)
  PORT
} = process.env;

// Falta de variáveis — falha cedo e com mensagem clara nos logs
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GROUP_CHAT_ID) throw new Error("Missing GROUP_CHAT_ID");
if (!PREMIUM_PRICE_ID) console.warn("WARN: PREMIUM_PRICE_ID not set");
if (!GENERIC_PRICE_ID) console.warn("WARN: GENERIC_PRICE_ID not set");

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// Healthcheck (Stripe usa para validar endpoint HTTPS às vezes)
app.get("/", (_req, res) => res.send("OK"));

// =============== STRIPE WEBHOOK ===============
// IMPORTANTE: para Stripe o body precisa ser RAW, então esta rota vem ANTES do express.json()
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
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    try {
      // Logs úteis para filtrar no Railway
      console.log("@received:", event.type);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        // 1) Tenta pegar telegram_id dos metadata direto da session (checkout)
        let telegramId = session?.metadata?.telegram_id;

        // 2) Se veio de assinatura (subscription) com metadata, tenta lá também
        if (!telegramId && session?.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          telegramId = sub?.metadata?.telegram_id;
        }

        if (!telegramId) {
          console.warn("No telegram_id in checkout.session.completed");
        } else {
          // Decide o “tier” pelo price comprado
          let tierLabel = "Generic";
          const priceId = session?.line_items?.data?.[0]?.price?.id || session?.metadata?.price_id;
          if (priceId === PREMIUM_PRICE_ID) tierLabel = "Premium";

          await sendInvite(String(telegramId), tierLabel);
        }
      }

      // (Opcional) Outros eventos só para você ver que está chegando
      if (event.type === "customer.created") console.log("customer.created OK");
      if (event.type === "customer.deleted") console.log("customer.deleted OK");
      if (event.type === "customer.updated") console.log("customer.updated OK");

      res.sendStatus(200);
    } catch (err) {
      console.error("Stripe handler error:", err);
      res.status(500).send("Handler error");
    }
  }
);

// Agora liberamos JSON padrão para as demais rotas
app.use(express.json());

// =============== TELEGRAM WEBHOOK ===============
// O Telegram vai postar updates exatamente nesse path: /bot<token>
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  try {
    console.log("@tg_update:", JSON.stringify(req.body));

    const msg = req.body.message;
    if (msg && msg.text) {
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();

      if (text === "/start") {
        await sendMessage(chatId,
          "🚀 Bem-vindo ao *Nexus Community Bot*!\n\n" +
          "Use o botão de checkout para assinar e receber seu convite automático."
        );
      }
    }

    // SEMPRE 200 para o Telegram não reenviar
    res.sendStatus(200);
  } catch (err) {
    console.error("telegram webhook error:", err);
    // Mesmo com erro, devolve 200 para não ficar reentregando indefinidamente
    res.sendStatus(200);
  }
});

// Opcional: endpoint utilitário para criar uma sessão de checkout via fetch do navegador
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, telegramId } = req.body;
    if (!priceId || !telegramId) {
      return res.status(400).json({ error: "Missing priceId or telegramId" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      // Essas URLs são meramente de retorno visual; o que vale é o webhook
      success_url: "https://t.me/NexusCommunityBRBot?start=ok",
      cancel_url: "https://t.me/NexusCommunityBRBot?start=cancel",
      // Gravamos o telegram_id para resgatar no webhook
      metadata: { telegram_id: String(telegramId), price_id: priceId },
      // Garantia extra para assinatura
      subscription_data: { metadata: { telegram_id: String(telegramId) } }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    res.status(500).json({ error: e.message });
  }
});

// =============== Funções auxiliares (Telegram) ===============
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown"
    }),
  });
}

async function sendInvite(telegramId, tierLabel = "Generic") {
  // Cria link de convite temporário para o GRUPO alvo
  const inviteRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: GROUP_CHAT_ID,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 1800 // 30 min
    }),
  }).then(r => r.json());

  const inviteLink = inviteRes?.result?.invite_link;
  if (!inviteLink) {
    console.error("Failed to create invite link:", inviteRes);
    return;
  }

  // Envia o convite por DM para o comprador
  await sendMessage(
    telegramId,
    `✅ *${tierLabel}* ativado!\n\n👉 Entre no grupo: ${inviteLink}\n\n` +
    `_Lembrete: memberships digitais não garantem emprego._`
  );
}

// =============== Start ===============
const listenPort = PORT || 8080;
app.listen(listenPort, () => {
  console.log(`server running on port ${listenPort}`);
});
