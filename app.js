require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ============================================================
   1 — CONFIG TWILIO (Réception)
   ============================================================ */
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.post("/webhook/twilio/incoming", async (req, res) => {
  const messageBody = req.body.Body;
  const fromNumber = req.body.From;

  console.log("📥 SMS Reçu :", { fromNumber, messageBody });

  // TODO : ton traitement interne (verification code, commandes, etc.)

  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
});

/* ============================================================
   2 — CONFIG ORANGE (Envoi SMS)
   ============================================================ */
async function sendSMSOrange(to, text) {
  try {
    const tokenResp = await axios.post(
      "https://api.orange.com/oauth/v3/token",
      "grant_type=client_credentials",
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              process.env.ORANGE_CLIENT_ID +
                ":" +
                process.env.ORANGE_CLIENT_SECRET
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const token = tokenResp.data.access_token;

    const smsResp = await axios.post(
      `https://api.orange.com/smsmessaging/v1/outbound/tel:${process.env.ORANGE_SENDER_ID}/requests`,
      {
        outboundSMSMessageRequest: {
          address: `tel:${to}`,
          outboundSMSTextMessage: { message: text },
          senderAddress: `tel:${process.env.ORANGE_SENDER_ID}`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("📤 SMS envoyé via Orange :", smsResp.data);
    return smsResp.data;
  } catch (err) {
    console.error("❌ Erreur Orange :", err.response?.data || err);
    throw err;
  }
}

/* ============================================================
   3 — ENDPOINT D’ENVOI SMS (ex : POSTMAN / FRONTEND)
   ============================================================ */
app.post("/sms/send", async (req, res) => {
  const { to, message } = req.body;

  try {
    const result = await sendSMSOrange(to, message);
    res.json({ success: true, result });
  } catch (e) {
    res.json({ success: false, error: e });
  }
});

/* ============================================================
   4 — LANCEMENT SERVEUR
   ============================================================ */
app.listen(3000, () => {
  console.log("🚀 OmniSMS backend running on port 3000");
});