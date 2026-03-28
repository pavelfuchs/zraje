require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// Create PaymentIntent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, items } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Minimální částka je 1 Kč' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount, // in CZK hellers (1 Kč = 100)
      currency: 'czk',
      automatic_payment_methods: { enabled: true },
      metadata: {
        items: JSON.stringify(items.map(i => i.name + ' x' + i.qty))
      }
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('API running on :' + PORT));
