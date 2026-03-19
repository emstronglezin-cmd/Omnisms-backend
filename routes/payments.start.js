const express = require('express');
const axios = require('axios');
const router = express.Router();

/* =========================================================
   🟡 MONEYFUSION (ANCIEN – CONSERVÉ POUR HISTORIQUE)
   ========================================================= */
// ⚠️ Ce bloc est volontairement conservé
// ⚠️ Il n’est plus utilisé en production

// router.post('/moneyfusion/init', async (req, res) => {
//   return res.status(503).json({ message: 'MoneyFusion temporairement indisponible' });
// });


/* =========================================================
   🟢 PAYDUNYA – ROUTE ACTIVE
   ========================================================= */

router.post('/start', async (req, res) => {
  try {
    const {
      amount = 2000,
      description = 'Abonnement OmniSMS Pro',
      customer_name,
      customer_phone
    } = req.body;

    const response = await axios.post(
      'https://app.paydunya.com/api/v1/checkout-invoice/create',
      {
        invoice: {
          total_amount: amount,
          description: description
        },
        store: {
          name: 'OmniSMS'
        },
        custom_data: {
          plan: 'pro'
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY,
          'PAYDUNYA-PUBLIC-KEY': process.env.PAYDUNYA_PUBLIC_KEY,
          'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
          'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN
        }
      }
    );

    if (!response.data || !response.data.response_text || !response.data.response_text.includes('success')) {
      return res.status(500).json({ error: 'Payment init error' });
    }

    return res.redirect(response.data.response.checkout_url);

  } catch (err) {
    console.error('PayDunya init error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Payment init error' });
  }
});

module.exports = router;
