const express = require('express');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

// Stripe webhook needs raw body BEFORE express.json()
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const email = pi.receipt_email || (pi.charges && pi.charges.data[0] && pi.charges.data[0].billing_details.email);
    const name = pi.charges && pi.charges.data[0] && pi.charges.data[0].billing_details.name;
    const items = pi.metadata.items ? JSON.parse(pi.metadata.items) : [];
    const total = pi.amount / 100;

    console.log('Payment succeeded:', pi.id, total, 'CZK', email);

    if (email) {
      const itemsList = items.map(i => String(i)).join('<br>');
      const { error } = await resend.emails.send({
        from: 'Kráva z ráje <objednavky@kravazraje.cz>',
        to: email,
        subject: 'Potvrzení objednávky — Kráva z ráje',
        html: `
          <h2>Díky za objednávku${name ? ', ' + name : ''}!</h2>
          <p><strong>Objednané kusy:</strong></p>
          <p>${itemsList}</p>
          <hr>
          <p><strong>Celkem: ${total},– Kč</strong></p>
          <p>K vyzvednutí v dohodnutém termínu na Pštrossova 22, Praha 1.</p>
          <p>— Pavel, Kráva z ráje</p>
        `
      });
      if (error) console.error('Email error:', error);
      else console.log('Confirmation email sent to', email);
    }
  }

  res.json({ received: true });
});

// JSON parsing for all other routes
app.use(express.json());

// Static files (frontend)
app.use(express.static(__dirname, { extensions: ['html'] }));

// Firestore (optional — used for admin API)
let db;
try {
  const { Firestore } = require('@google-cloud/firestore');
  db = new Firestore();
} catch (e) {
  console.log('Firestore not available:', e.message);
}

// API: list drops
app.get('/api/drops', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const snapshot = await db.collection('drops').get();
    const drops = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    drops.sort((a, b) => a.name.localeCompare(b.name));
    res.json(drops);
  } catch (err) {
    console.error('Drops error:', err.message);
    res.json([]);
  }
});

// API: get single drop with products
app.get('/api/drops/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const doc = await db.collection('drops').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const drop = { id: doc.id, ...doc.data() };

    // Get products linked to this drop
    const prodSnap = await db.collection('products').get();
    const products = prodSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => (p.dropIds || []).includes(doc.id));

    // Get stocked parts for this drop
    const partsSnap = await db.collection('drops').doc(req.params.id).collection('parts').get();
    const parts = partsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({ drop, products, parts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: update drop info (purchase price, weight, slaughter date)
app.post('/api/drops/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const allowed = ['purchasePrice', 'totalWeight', 'deadWeight', 'butcheredWeight', 'slaughterDate', 'name', 'shortName'];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    await db.collection('drops').doc(req.params.id).update(update);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: add/update a stocked part for a drop
app.post('/api/drops/:id/parts', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const { productId, productName, weight, quarter, notes, labelDesc, status } = req.body;
    const part = {
      productId: productId || '',
      productName: productName || '',
      weight: weight || 0,
      quarter: quarter || '',
      notes: notes || '',
      labelDesc: labelDesc || '',
      status: status || 'aging',
      stockedAt: new Date().toISOString()
    };
    const ref = await db.collection('drops').doc(req.params.id).collection('parts').add(part);
    res.json({ id: ref.id, ...part });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: update stocked part status (aging/frozen/given/sold)
app.post('/api/drops/:id/parts/:partId/status', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const { status } = req.body;
    if (!['aging', 'frozen', 'given', 'sold'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await db.collection('drops').doc(req.params.id).collection('parts').doc(req.params.partId).update({
      status,
      [status + 'At']: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: update stocked part weight
app.post('/api/drops/:id/parts/:partId/weight', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    await db.collection('drops').doc(req.params.id).collection('parts').doc(req.params.partId).update({
      weight: req.body.weight || 0
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: delete a stocked part
app.delete('/api/drops/:id/parts/:partId', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    await db.collection('drops').doc(req.params.id).collection('parts').doc(req.params.partId).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: update product (aging settings etc.)
app.post('/api/products/:id', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const allowed = ['agingType', 'agingMethod', 'optimalAgingDays', 'czkPrice', 'weight', 'labelDescription'];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    await db.collection('products').doc(req.params.id).update(update);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: list orders
app.get('/api/orders', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (err) {
    console.error('Orders error:', err.message);
    res.json([]);
  }
});

// API: check Stripe payment status for an order
app.get('/api/orders/:id/stripe', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const doc = await db.collection('orders').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const order = doc.data();
    if (!order.stripePaymentIntentId) return res.json({ status: 'no_payment_intent' });
    const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
    res.json({
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      created: pi.created,
      paymentMethod: pi.payment_method_types
    });
  } catch (err) {
    console.error('Stripe check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: count new orders (paid but not delivered)
app.get('/api/orders/count/new', async (req, res) => {
  if (!db) return res.json({ count: 0 });
  try {
    const snapshot = await db.collection('orders').get();
    const count = snapshot.docs.filter(doc => {
      const d = doc.data();
      return d.paidAt && !d.deliveredAt;
    }).length;
    res.json({ count });
  } catch (err) {
    res.json({ count: 0 });
  }
});

// API: update order status
app.post('/api/orders/:id/status', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const { field } = req.body;
    if (!['preparedAt', 'deliveredAt'].includes(field)) {
      return res.status(400).json({ error: 'Invalid field' });
    }
    await db.collection('orders').doc(req.params.id).update({
      [field]: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: list all contacts (customers + subscribers merged)
app.get('/api/contacts', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const contacts = new Map();

    // Customers from orders
    const ordersSnap = await db.collection('orders').get();
    ordersSnap.docs.forEach(doc => {
      const o = doc.data();
      if (!o.email) return;
      const key = o.email.toLowerCase();
      if (!contacts.has(key)) {
        contacts.set(key, { email: o.email, tel: o.tel || '', name: o.fullName || '', source: 'order', orderCount: 0, totalSpent: 0, subscribedAt: null, unsubscribedAt: null });
      }
      const c = contacts.get(key);
      c.orderCount++;
      c.totalSpent += (o.lines || []).reduce((s, l) => s + (l.czkPrice || 0) * (l.quantity || 1), 0);
      if (!c.name && o.fullName) c.name = o.fullName;
      if (!c.tel && o.tel) c.tel = o.tel;
    });

    // Subscribers
    const subsSnap = await db.collection('subscribers').get();
    subsSnap.docs.forEach(doc => {
      const s = doc.data();
      const contact = s.contact || '';
      const isEmail = contact.includes('@');
      const key = isEmail ? contact.toLowerCase() : 'tel:' + contact;
      if (!contacts.has(key)) {
        contacts.set(key, { email: isEmail ? contact : '', tel: isEmail ? '' : contact, name: '', source: 'subscriber', orderCount: 0, totalSpent: 0, subscribedAt: s.createdAt, unsubscribedAt: s.unsubscribedAt || null });
      } else {
        contacts.get(key).subscribedAt = s.createdAt;
        if (s.unsubscribedAt) contacts.get(key).unsubscribedAt = s.unsubscribedAt;
      }
    });

    res.json(Array.from(contacts.values()).sort((a, b) => (b.orderCount || 0) - (a.orderCount || 0)));
  } catch (err) {
    console.error('Contacts error:', err.message);
    res.json([]);
  }
});

// API: send bulk message
app.post('/api/contacts/send', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  try {
    const { subject, message, recipients } = req.body;
    if (!subject || !message || !recipients || !recipients.length) {
      return res.status(400).json({ error: 'Missing subject, message or recipients' });
    }

    const results = { sent: 0, failed: 0, errors: [] };

    for (const email of recipients) {
      if (!email || !email.includes('@')) continue;
      const unsubUrl = 'https://kravazraje.cz/odhlasit?email=' + encodeURIComponent(email);
      const { error } = await resend.emails.send({
        from: 'Kráva z ráje <info@kravazraje.cz>',
        to: email,
        subject: subject,
        html: message.replace(/\n/g, '<br>') +
          '<br><br><hr style="border:none;border-top:1px solid #eee;margin:2em 0 1em">' +
          '<p style="font-size:12px;color:#999">Nechcete dostávat zprávy? <a href="' + unsubUrl + '">Odhlásit se</a></p>'
      });
      if (error) {
        results.failed++;
        results.errors.push(email + ': ' + error.message);
      } else {
        results.sent++;
      }
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unsubscribe page
app.get('/odhlasit', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.send('<h2>Chybí email</h2>');
  if (db) {
    try {
      const snap = await db.collection('subscribers').where('contact', '==', email).get();
      snap.docs.forEach(doc => doc.ref.update({ unsubscribedAt: new Date().toISOString() }));
      // Also mark in a dedicated unsubscribe collection
      await db.collection('unsubscribed').doc(email.toLowerCase().replace(/[^a-z0-9]/g, '_')).set({
        email: email,
        unsubscribedAt: new Date().toISOString()
      });
    } catch (e) { console.error('Unsubscribe error:', e.message); }
  }
  res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Odhlášeno</title></head><body style="font-family:sans-serif;text-align:center;padding:3em;color:#ff0707"><h2>Odhlášeno</h2><p>Váš email <strong>' + email + '</strong> byl odhlášen z odběru.</p><p><a href="/" style="color:#ff0707">Zpět na kravazraje.cz</a></p></body></html>');
});

// API: subscribe (email/phone for notifications)
app.post('/api/subscribe', async (req, res) => {
  if (!db) return res.json({ ok: true });
  try {
    const { contact } = req.body;
    if (!contact) return res.status(400).json({ error: 'Missing contact' });
    await db.collection('subscribers').add({
      contact,
      createdAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true }); // don't fail visibly
  }
});

// Stripe API endpoint
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, items, email } = req.body;
    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Minimalni castka je 1 Kc' });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'czk',
      automatic_payment_methods: { enabled: true },
      receipt_email: email || undefined,
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Running on :' + PORT));
