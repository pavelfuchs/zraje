const { Firestore } = require('@google-cloud/firestore');
const data = require('/tmp/contember_full.json').data;

const db = new Firestore({ projectId: 'zraje-app' });

async function migrate() {
  console.log('Starting migration...');

  // 1. Tags
  console.log(`\nMigrating ${data.listDropTag.length} tags...`);
  for (const tag of data.listDropTag) {
    await db.collection('tags').doc(tag.id).set({
      name: tag.name,
      handle: tag.handle
    });
  }
  console.log('  Tags done.');

  // 2. Products
  console.log(`\nMigrating ${data.listProduct.length} products...`);
  for (const p of data.listProduct) {
    await db.collection('products').doc(p.id).set({
      handle: p.handle,
      name: p.name,
      shortDescription: p.shortDescription || '',
      czkPrice: p.czkPrice,
      weight: p.weight || '',
      availableQuantity: p.availableQuantity,
      mapSegment: p.mapSegment || '',
      selector: p.selector || '',
      tagIds: p.tags.map(t => t.id),
      tagNames: p.tags.map(t => t.name),
      dropIds: p.drops.map(d => d.drop.id),
      dropNames: p.drops.map(d => d.drop.name)
    });
  }
  console.log('  Products done.');

  // 3. Drops (krávy)
  console.log(`\nMigrating ${data.listDrop.length} drops...`);
  for (const drop of data.listDrop) {
    await db.collection('drops').doc(drop.id).set({
      name: drop.name,
      handle: drop.handle || '',
      shortName: drop.shortName || '',
      longName: drop.longName || '',
      publishedAt: drop.publishedAt || null,
      soldOutAt: drop.soldOutAt || null,
      deliverySlots: (drop.deliverySlots || []).map(s => ({
        id: s.id,
        date: s.date || '',
        short: s.short || '',
        description: s.description || ''
      }))
    });
  }
  console.log('  Drops done.');

  // 4. Orders
  console.log(`\nMigrating ${data.listOrder.length} orders...`);
  for (const order of data.listOrder) {
    await db.collection('orders').doc(order.id).set({
      number: order.number,
      createdAt: order.createdAt,
      email: order.email || '',
      fullName: order.fullName || '',
      tel: order.tel || '',
      paidAt: order.paidAt || null,
      fulfilledAt: order.fulfilledAt || null,
      note: order.note || '',
      shippingMethod: order.shippingMethod || '',
      shippingAddress: order.shippingAddress || '',
      stripePaymentIntentId: order.stripePaymentIntentId || '',
      lines: (order.lines || []).map(l => ({
        id: l.id,
        quantity: l.quantity,
        czkPrice: l.czkPrice,
        productHandle: l.productHandle || '',
        productName: l.product && l.product.product ? l.product.product.name : '',
        productId: l.product && l.product.product ? l.product.product.id : '',
        deliverySlotName: l.deliverySlotName || ''
      }))
    });
  }
  console.log('  Orders done.');

  // 5. Customers (extract unique from orders)
  console.log('\nExtracting customers from orders...');
  const customers = {};
  for (const order of data.listOrder) {
    const email = order.email;
    if (!email) continue;
    if (!customers[email]) {
      customers[email] = {
        email,
        fullName: order.fullName || '',
        tel: order.tel || '',
        orderCount: 0,
        totalSpent: 0,
        firstOrderAt: order.createdAt,
        lastOrderAt: order.createdAt
      };
    }
    customers[email].orderCount++;
    const orderTotal = (order.lines || []).reduce((sum, l) => sum + l.czkPrice * l.quantity, 0);
    customers[email].totalSpent += orderTotal;
    if (order.createdAt > customers[email].lastOrderAt) {
      customers[email].lastOrderAt = order.createdAt;
      customers[email].fullName = order.fullName || customers[email].fullName;
      customers[email].tel = order.tel || customers[email].tel;
    }
    if (order.createdAt < customers[email].firstOrderAt) {
      customers[email].firstOrderAt = order.createdAt;
    }
  }

  const customerList = Object.values(customers);
  console.log(`  ${customerList.length} unique customers found.`);
  for (const c of customerList) {
    const docId = c.email.replace(/[^a-zA-Z0-9]/g, '_');
    await db.collection('customers').doc(docId).set(c);
  }
  console.log('  Customers done.');

  console.log('\n=== Migration complete! ===');
  console.log(`  Tags: ${data.listDropTag.length}`);
  console.log(`  Products: ${data.listProduct.length}`);
  console.log(`  Drops: ${data.listDrop.length}`);
  console.log(`  Orders: ${data.listOrder.length}`);
  console.log(`  Customers: ${customerList.length}`);
}

migrate().catch(console.error);
