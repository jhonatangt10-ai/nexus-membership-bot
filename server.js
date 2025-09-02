// server.js — Nexus Membership Bot (Stripe + Telegram)
// Node 18+ / ESM

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import fetch from "node-fetch";

// ====== ENV VARS (configure no Railway) ======
const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  GROUP_CHAT_ID,       // ex: -1003037084693 (número negativo do supergroup)
  PREMIUM_PRICE_ID,    // ex: price_...
  GENERIC_PRICE_ID,    // ex: price_...
  PORT
} = process.env;

// ====== Guardiões de configuração ======
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GROUP_CHAT_ID) throw new Error("Missing GROUP_CHAT_ID");
// Os PRICE_IDs podem ser opcionais dependendo do seu fluxo,
// mas se você já os usa no front, mantemos o alerta se não vierem:
if (!GENERIC_PRICE_ID) console.warn("WARN: GENERIC_PRICE_ID não configurado.");
if (!PREMIUM_PRICE_ID) console.warn("WARN: PREMIUM_PRICE_ID não configurado.");

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// ====== Healthcheck ======
app.get("/", (_req, res) => res.status(200).send("OK"));

// IMPORTANTE: o webhook do Stripe precisa vir **ANTES** do express.json()
// e com body RAW para validar a assinatura.
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
      // Trate apenas os eventos que você selecionou no Stripe Workbench
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          // Pegamos o telegram_id salvo nos metadata
          const telegramId =
            session.metadata?.telegram_id ||
            session.subscription_metadata?.telegram_id ||
            null;

          // Label/nível do plano (opcional)
          const tierLabel =
            session.metadata?.tier ||
            (session.mode === "subscription" ? "Premium" : "Generic");

          if (!telegramId) {
            console.warn("No telegram_id in session metadata.");
            break;
          }

          // Cria link de convite de uso único (30 min)
          const invite = await createInviteLink();
          if (invite) {
            await sendTelegramMessage(telegramId, `✅ *${tierLabel}* ativado.\nEntre no grupo: ${invite}`, "Markdown");
          }
          break;
        }

        case "customer.created":
        case "customer.updated":
        case "customer.deleted": {
          // Eventos informativos (opcional log)
          console.log("Stripe event:", event.type);
          break;
        }

        default:
          console.log("Unhandled event type:", event.type);
      }
      res.json({ received: true });
    } catch (err) {
      console.error("Webhook handler error:", err);
      res.status(500).send("Internal webhook error");
    }
  }
);

// Agora podemos habilitar JSON para o resto das rotas
app.use(express.json());

// ====== Criar sessão de checkout ======
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, telegramId } = req.body;
    if (!priceId || !telegramId) {
      return res.status(400).json({ error: "Missing priceId or telegramId" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      // Salve o telegramId nos metadata para resgatar no webhook:
      metadata: { telegram_id: String(telegramId) },
      success_url: "https://t.me/NexusCommunityBRBot?start=ok",
      cancel_url: "https://t.me/NexusCommunityBRBot?start=cancel"
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ====== Webhook do Telegram (recebe updates) ======
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update?.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text || "";

      if (text.startsWith("/start")) {
        const me = await getMe();
        const name = me?.result?.first_name || "bot";
        await sendTelegramMessage(
          chatId,
          `Olá! Eu sou o *${name}*.\n\nPara assinar, escolha um plano e eu te envio o link do grupo depois do pagamento. Se já pagou, apenas aguarde: eu verifico no Stripe e libero seu acesso.`,
          "Markdown"
        );
      } else {
        await sendTelegramMessage(chatId, "🤖 Comando não reconhecido.");
      }
    }

    // sempre 200 pro Telegram
    res.json({ ok: true });
  } catch (err) {
    console.error("telegram-webhook error:", err);
    res.json({ ok: true });
  }
});

// ====== Diagnóstico: quem é o bot? ======
app.get("/whoami", async (_req, res) => {
  try {
    const me = await getMe();
    res.json(me);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Helpers de Telegram ======
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function getMe() {
  const r = await fetch(`${TG_API}/getMe`);
  return r.json();
}

async function sendTelegramMessage(chatId, text, parseMode = undefined) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;

  const r = await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await r.json();
  if (!json.ok) {
    console.error("Error sending telegram message:", json);
  }
  return json;
}

async function createInviteLink() {
  // Link único, 1 uso, expira em 30min
  const body = {
    chat_id: GROUP_CHAT_ID,
    member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 1800
  };

  const r = await fetch(`${TG_API}/createChatInviteLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await r.json();
  if (!json.ok) {
    console.error("createChatInviteLink error:", json);
    return null;
  }
  return json.result?.invite_link || null;
}

// ====== Start ======
const port = Number(PORT || 8080);
app.listen(port, () => {
  console.log(`server running on port ${port}`);
});
