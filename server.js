// server.js — Nexus Membership Bot (Stripe + Telegram)
import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import fetch from "node-fetch";

/* ===== Variáveis de ambiente =====
  STRIPE_SECRET_KEY      (sk_live_... ou sk_test_...)
  STRIPE_WEBHOOK_SECRET  (whsec_...)
  TELEGRAM_BOT_TOKEN     (8429...:AA...)
  GROUP_CHAT_ID          (-100xxxxxxxxxx)  // grupo destino
  GENERIC_PRICE_ID       (price_xxx)       // plano 1
  PREMIUM_PRICE_ID       (price_xxx)       // plano 2 (opcional)
  BASE_URL               (https://<seu-app>.up.railway.app)
  PORT                   (opcional: 8080)
*/

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  GROUP_CHAT_ID,
  GENERIC_PRICE_ID,
  PREMIUM_PRICE_ID,
  BASE_URL,
  PORT
} = process.env;

// Checks early
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GROUP_CHAT_ID) throw new Error("Missing GROUP_CHAT_ID");
if (!GENERIC_PRICE_ID) throw new Error("Missing GENERIC_PRICE_ID");
if (!BASE_URL) throw new Error("Missing BASE_URL");

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// Healthcheck
app.get("/", (_req, res) => res.send("OK"));

// ========= TELEGRAM =========
// Webhook do Telegram deve receber JSON "puro"
app.post("/telegram-webhook",
  bodyParser.json(),
  async (req, res) => {
    try {
      const update = req.body;

      // Mensagem /start → manda botões para escolher plano
      const msg = update.message;
      if (msg && msg.text && msg.text.trim().toLowerCase() === "/start") {
        const chatId = msg.chat.id;

        const keyboard = {
          inline_keyboard: [
            [
              { text: "Assinar (Plano Genérico)", callback_data: "buy:GENERIC" },
              ...(PREMIUM_PRICE_ID ? [{ text: "Assinar (Plano Premium)", callback_data: "buy:PREMIUM" }] : [])
            ]
          ]
        };

        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "Escolha um plano para assinar:",
            reply_markup: keyboard
          })
        });

        return res.json({ ok: true });
      }

      // Clique nos botões → cria sessão de checkout
      const cb = update.callback_query;
      if (cb && cb.data && cb.data.startsWith("buy:")) {
        const choice = cb.data.split(":")[1]; // "GENERIC" | "PREMIUM"
        const priceId = choice === "PREMIUM" && PREMIUM_PRICE_ID ? PREMIUM_PRICE_ID : GENERIC_PRICE_ID;

        // cria sessão
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: "https://t.me/NexusCommunityBRBot?start=ok",
          cancel_url: "https://t.me/NexusCommunityBRBot?start=cancel",
          metadata: {
            telegram_id: String(cb.from.id) // IMPORTANTÍSSIMO
          }
        });

        // Responder com o link
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: cb.id,
            url: session.url
          })
        });

        return res.json({ ok: true });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("TG webhook error:", err);
      res.status(200).json({ ok: true }); // Telegram exige 200 rápido
    }
  }
);

// ========= STRIPE =========
// ATENÇÃO: tem que vir RAW para validar assinatura
app.post("/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const tgId = session.metadata?.telegram_id;
          if (!tgId) break;

          // cria link de convite temporário
          const invite = await createInviteLink();
          if (invite) {
            await sendDM(tgId, `✅ Assinatura ativada!\nEntre no grupo: ${invite}\n\nLembrete: assinatura digital não garante emprego.`);
          }
          break;
        }

        // Renovações
        case "invoice.payment_succeeded": {
          const invoice = event.data.object;
          const tgId = invoice.metadata?.telegram_id || invoice.customer_email || ""; // tente recuperar
          if (!tgId) break;

          const invite = await createInviteLink();
          if (invite) {
            // aqui tentamos DM; se tgId não for numérico, esse send pode falhar silenciosamente
            await sendDM(tgId, `💳 Pagamento confirmado! Seu acesso está ativo.\nLink do grupo: ${invite}`);
          }
          break;
        }

        // Cancelamentos
        case "customer.subscription.deleted": {
          // opcional: enviar aviso/retirar do grupo
          break;
        }

        default:
          // ignore
      }

      res.json({ received: true });
    } catch (err) {
      console.error("Stripe handler error:", err);
      res.status(200).json({ received: true });
    }
  }
);

// helpers
async function createInviteLink() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: GROUP_CHAT_ID,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 1800 // 30min
    })
  });
  const j = await r.json();
  return j.result?.invite_link || null;
}

async function sendDM(telegramId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramId,
      text,
      parse_mode: "Markdown"
    })
  });
}

const port = Number(PORT) || 8080;
app.listen(port, () => console.log("server running on port", port));
