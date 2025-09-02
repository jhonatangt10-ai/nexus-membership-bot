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
  GROUP_CHAT_ID,       // ex: -1003037084693
  PREMIUM_PRICE_ID,    // price_... (Premium)
  GENERIC_PRICE_ID,    // price_... (Generic)
  PUBLIC_URL,          // ex: https://nexus-membership-bot-production.up.railway.app
  PORT
} = process.env;

// Falta algo? derruba cedo com mensagem clara
if (!STRIPE_SECRET_KEY)   throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!TELEGRAM_BOT_TOKEN)  throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GROUP_CHAT_ID)       throw new Error("Missing GROUP_CHAT_ID");
if (!PREMIUM_PRICE_ID)    throw new Error("Missing PREMIUM_PRICE_ID");
if (!GENERIC_PRICE_ID)    throw new Error("Missing GENERIC_PRICE_ID");
if (!PUBLIC_URL)          throw new Error("Missing PUBLIC_URL");

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// Healthcheck — útil pro Railway
app.get("/", (_req, res) => res.send("OK"));

// =====================================================
// IMPORTANTE: o webhook do Stripe precisa do corpo RAW!
// Coloque esta rota ANTES do app.use(express.json()).
// =====================================================
app.post("/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("✖ Webhook signature verification failed:", err?.message || err);
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          // Pega o telegram_id tanto do session.metadata quanto do subscription.metadata
          let telegramId =
            session?.metadata?.telegram_id ||
            session?.subscription_metadata?.telegram_id;

          // Se o Stripe não “promoveu” pro campo acima, tente buscar a Subscription
          if (!telegramId && session?.subscription) {
            try {
              const sub = await stripe.subscriptions.retrieve(session.subscription);
              telegramId = sub?.metadata?.telegram_id;
            } catch (e) { /* ignora */ }
          }

          if (!telegramId) {
            console.warn("⚠ checkout.session.completed sem telegram_id na metadata");
            break;
          }

          // Descobre o rótulo do plano (apenas para mensagem)
          const line = (session?.display_items?.[0] || session?.line_items?.[0]);
          const tierLabel = line?.price?.nickname || line?.price?.id || "Plano";

          await sendInvite(telegramId, tierLabel);
          break;
        }

        case "customer.created":
        case "customer.updated":
        case "customer.deleted":
          // Opcional: log leve pra depuração
          console.log("Stripe event:", event.type);
          break;

        default:
          console.log("Unhandled event:", event.type);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("Webhook handler error:", err?.message || err);
      res.status(500).send("handler error");
    }
  }
);

// Depois do webhook do Stripe, o resto pode usar JSON normalmente
app.use(express.json());

// ===== util: criar convite e enviar DM no Telegram =====
async function sendInvite(telegramId, tierLabel) {
  // Cria um link de convite de 30 minutos, 1 uso
  const inviteResp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: GROUP_CHAT_ID,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 1800 // 30 min
    })
  }).then(r => r.json());

  const invite = inviteResp?.result?.invite_link;

  // Envia mensagem privada com o link
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramId,
      text:
        invite
          ? `✅ *${tierLabel}* ativado.\nEntre no grupo: ${invite}\n\n_Lembrete: associações digitais não garantem emprego._`
          : `✅ *${tierLabel}* ativado.\n⚠️ Não consegui gerar o link agora. Fale com um admin.`,
      parse_mode: "Markdown"
    })
  });
}

// ===== Webhook do Telegram: responde /start com botões =====
app.post("/tg-webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update?.message?.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();

      if (text === "/start") {
        const keyboard = {
          inline_keyboard: [
            [
              { text: "Assinar — Generic", url: `${PUBLIC_URL}/checkout?plan=generic&tg=${chatId}` }
            ],
            [
              { text: "Assinar — Premium", url: `${PUBLIC_URL}/checkout?plan=premium&tg=${chatId}` }
            ]
          ]
        };

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "Escolha um plano para assinar 👇",
            reply_markup: keyboard
          })
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("tg-webhook error:", err?.message || err);
    res.sendStatus(200);
  }
});

// ===== Rota de checkout: cria sessão do Stripe e redireciona =====
app.get("/checkout", async (req, res) => {
  try {
    const plan = String(req.query.plan || "");
    const telegramId = String(req.query.tg || "");
    if (!telegramId) return res.status(400).send("Missing tg");

    const priceId =
      plan === "premium" ? PREMIUM_PRICE_ID :
      plan === "generic" ? GENERIC_PRICE_ID : null;

    if (!priceId) return res.status(400).send("Invalid plan");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://t.me/NexusCommunityBRBot?start=ok",
      cancel_url:  "https://t.me/NexusCommunityBRBot?start=cancel",
      subscription_data: { metadata: { telegram_id: String(telegramId) } },
      metadata: { telegram_id: String(telegramId) }
    });

    res.redirect(303, session.url);
  } catch (e) {
    console.error("/checkout error:", e?.message || e);
    res.status(500).send("checkout error");
  }
});

// ===== Rota de diagnóstico: whoami do Telegram (opcional) =====
app.get("/whoami", async (_req, res) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`).then(x => x.json());
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Sobe o servidor
const listenPort = Number(PORT || 8080);
app.listen(listenPort, () => {
  console.log(`server running on port ${listenPort}`);
});
