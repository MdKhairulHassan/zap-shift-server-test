'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const Stripe = require('stripe');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Cache the connection promise across warm Vercel invocations. A rejected
// attempt is cleared so a later request can retry a transient connection error.
const cache = globalThis.__zapShiftMongo || (globalThis.__zapShiftMongo = {});
function getDb() {
  if (!process.env.URI)
    throw new Error('Missing required environment variable: URI');
  if (!cache.client) {
    cache.client = new MongoClient(process.env.URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
    });
  }
  if (!cache.dbPromise) {
    cache.dbPromise = cache.client
      .connect()
      .then(() => cache.client.db('zap_shift_db'))
      .catch(error => {
        cache.dbPromise = null;
        throw error;
      });
  }
  return cache.dbPromise;
}

function collection(name) {
  return getDb().then(db => db.collection(name));
}

function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) {
    const error = new Error('Invalid ID');
    error.status = 400;
    throw error;
  }
  return new ObjectId(value);
}

function getFirebaseAuth() {
  if (!getApps().length) {
    const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!encoded)
      throw new Error(
        'Missing required environment variable: FIREBASE_SERVICE_ACCOUNT_BASE64',
      );
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(
        Buffer.from(encoded, 'base64').toString('utf8'),
      );
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_BASE64 must contain base64-encoded service-account JSON',
      );
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getAuth();
}

function getStripe() {
  if (!process.env.STRIPE_SECRET)
    throw new Error('Missing required environment variable: STRIPE_SECRET');
  if (!cache.stripe) cache.stripe = new Stripe(process.env.STRIPE_SECRET);
  return cache.stripe;
}

function generateTrackingId() {
  return `PRCL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function verifyFBToken(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).send({ message: 'unauthorized access' });
  try {
    const decoded = await getFirebaseAuth().verifyIdToken(match[1]);
    req.decoded_email = decoded.email;
    return next();
  } catch {
    return res.status(401).send({ message: 'unauthorized access' });
  }
}

function roleRequired(role) {
  return asyncRoute(async (req, res, next) => {
    const users = await collection('users');
    const user = await users.findOne({ email: req.decoded_email });
    if (!user || user.role !== role)
      return res.status(403).send({ message: 'forbidden access' });
    return next();
  });
}

const verifyAdmin = roleRequired('admin');
const verifyRider = roleRequired('rider'); // Retained for use by rider-only routes.

async function logTracking(trackingId, status) {
  const trackings = await collection('trackings');
  return trackings.insertOne({
    trackingId,
    status,
    details: String(status).split('_').join(' '),
    createdAt: new Date(),
  });
}

app.get('/', (req, res) => res.send('Zap is shifting shifting!'));

// User APIs
app.get(
  '/users',
  verifyFBToken,
  asyncRoute(async (req, res) => {
    const users = await collection('users');
    const query = {};
    if (req.query.searchText) {
      const escaped = String(req.query.searchText).replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );
      query.$or = [
        { displayName: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
    }
    res.send(
      await users.find(query).sort({ createdAt: -1 }).limit(5).toArray(),
    );
  }),
);

// The uploaded source declared this route with an empty handler. Keep the URL
// explicit and return a clear response until the intended lookup is specified.
app.get('/users/:id', (req, res) =>
  res.status(501).send({ message: 'This endpoint is not implemented.' }),
);

app.get(
  '/users/:email/role',
  asyncRoute(async (req, res) => {
    const users = await collection('users');
    const user = await users.findOne({ email: req.params.email });
    res.send({ role: user?.role || 'user' });
  }),
);

app.post(
  '/users',
  asyncRoute(async (req, res) => {
    const users = await collection('users');
    const user = { ...req.body, role: 'user', createdAt: new Date() };
    if (!user.email)
      return res.status(400).send({ message: 'email is required' });
    if (await users.findOne({ email: user.email }))
      return res.send({ message: 'user exists' });
    res.send(await users.insertOne(user));
  }),
);

app.patch(
  '/users/:id/role',
  verifyFBToken,
  verifyAdmin,
  asyncRoute(async (req, res) => {
    if (!['user', 'admin', 'rider'].includes(req.body.role))
      return res.status(400).send({ message: 'invalid role' });
    const users = await collection('users');
    res.send(
      await users.updateOne(
        { _id: objectId(req.params.id) },
        { $set: { role: req.body.role } },
      ),
    );
  }),
);

// Parcel APIs
app.get(
  '/parcels',
  asyncRoute(async (req, res) => {
    const query = {};
    if (req.query.email) query.senderEmail = req.query.email;
    if (req.query.deliveryStatus)
      query.deliveryStatus = req.query.deliveryStatus;
    const parcels = await collection('parcels');
    res.send(await parcels.find(query).sort({ createdAt: -1 }).toArray());
  }),
);

app.get(
  '/parcels/rider',
  asyncRoute(async (req, res) => {
    const query = {};
    if (req.query.riderEmail) query.riderEmail = req.query.riderEmail;
    query.deliveryStatus =
      req.query.deliveryStatus === 'parcel_delivered'
        ? 'parcel_delivered'
        : { $nin: ['parcel_delivered'] };
    const parcels = await collection('parcels');
    res.send(await parcels.find(query).toArray());
  }),
);

app.get(
  '/parcels/:id',
  asyncRoute(async (req, res) => {
    const parcels = await collection('parcels');
    res.send(await parcels.findOne({ _id: objectId(req.params.id) }));
  }),
);

app.get(
  '/parcels/delivery-status/stats',
  asyncRoute(async (req, res) => {
    const parcels = await collection('parcels');
    res.send(
      await parcels
        .aggregate([
          { $group: { _id: '$deliveryStatus', count: { $sum: 1 } } },
          { $project: { status: '$_id', count: 1, _id: 0 } },
        ])
        .toArray(),
    );
  }),
);

app.post(
  '/parcels',
  asyncRoute(async (req, res) => {
    const parcels = await collection('parcels');
    const trackingId = generateTrackingId();
    const parcel = { ...req.body, createdAt: new Date(), trackingId };
    const inserted = await parcels.insertOne(parcel);
    await logTracking(trackingId, 'parcel_created');
    res.send(inserted);
  }),
);

app.patch(
  '/parcels/:id',
  asyncRoute(async (req, res) => {
    const { riderId, riderName, riderEmail, trackingId } = req.body;
    if (!riderId || !trackingId)
      return res
        .status(400)
        .send({ message: 'riderId and trackingId are required' });
    const parcels = await collection('parcels');
    const riders = await collection('riders');
    await parcels.updateOne(
      { _id: objectId(req.params.id) },
      {
        $set: {
          deliveryStatus: 'driver_assigned',
          riderId,
          riderName,
          riderEmail,
        },
      },
    );
    const result = await riders.updateOne(
      { _id: objectId(riderId) },
      { $set: { workStatus: 'in_delivery' } },
    );
    await logTracking(trackingId, 'driver_assigned');
    res.send(result);
  }),
);

app.patch(
  '/parcels/:id/status',
  asyncRoute(async (req, res) => {
    const { deliveryStatus, riderId, trackingId } = req.body;
    if (!deliveryStatus || !trackingId)
      return res
        .status(400)
        .send({ message: 'deliveryStatus and trackingId are required' });
    if (deliveryStatus === 'parcel_delivered' && !riderId)
      return res
        .status(400)
        .send({ message: 'riderId is required for delivery completion' });
    const parcels = await collection('parcels');
    const result = await parcels.updateOne(
      { _id: objectId(req.params.id) },
      { $set: { deliveryStatus } },
    );
    if (result.matchedCount === 0)
      return res.status(404).send({ message: 'parcel not found' });
    if (deliveryStatus === 'parcel_delivered') {
      const riders = await collection('riders');
      await riders.updateOne(
        { _id: objectId(riderId) },
        { $set: { workStatus: 'available' } },
      );
    }
    await logTracking(trackingId, deliveryStatus);
    res.send(result);
  }),
);

app.delete(
  '/parcels/:id',
  asyncRoute(async (req, res) => {
    const parcels = await collection('parcels');
    res.send(await parcels.deleteOne({ _id: objectId(req.params.id) }));
  }),
);

// Payments
app.post(
  '/payment-checkout-session',
  asyncRoute(async (req, res) => {
    const parcelInfo = req.body;
    const cost = Number(parcelInfo.cost);
    if (
      !Number.isFinite(cost) ||
      cost <= 0 ||
      !parcelInfo.parcelId ||
      !parcelInfo.trackingId
    ) {
      return res
        .status(400)
        .send({ message: 'valid cost, parcelId, and trackingId are required' });
    }
    if (!process.env.SITE_DOMAIN)
      throw new Error('Missing required environment variable: SITE_DOMAIN');
    const session = await getStripe().checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(cost * 100),
            product_data: { name: `please pay for ${parcelInfo.parcelName}` },
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: {
        parcelId: String(parcelInfo.parcelId),
        parcelName: String(parcelInfo.parcelName || ''),
        trackingId: String(parcelInfo.trackingId),
      },
      customer_email: parcelInfo.senderEmail,
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });
    res.send({ url: session.url });
  }),
);

app.patch(
  '/payment-success',
  asyncRoute(async (req, res) => {
    if (!req.query.session_id)
      return res.status(400).send({ message: 'session_id is required' });
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(
      req.query.session_id,
    );
    if (
      !session.payment_intent ||
      !session.metadata?.parcelId ||
      !session.metadata?.trackingId
    ) {
      return res
        .status(400)
        .send({ message: 'invalid checkout session metadata' });
    }
    const payments = await collection('payments');
    const transactionId = session.payment_intent;
    const existing = await payments.findOne({ transactionId });
    if (existing)
      return res.send({
        message: 'already exists',
        transactionId,
        trackingId: existing.trackingId,
      });
    if (session.payment_status !== 'paid') return res.send({ success: false });
    const parcels = await collection('parcels');
    const parcelResult = await parcels.updateOne(
      { _id: objectId(session.metadata.parcelId) },
      { $set: { paymentStatus: 'paid', deliveryStatus: 'pending-pickup' } },
    );
    if (!parcelResult.matchedCount)
      return res.status(404).send({ message: 'parcel not found' });
    const payment = {
      amount: session.amount_total / 100,
      currency: session.currency,
      customerEmail: session.customer_email,
      parcelId: session.metadata.parcelId,
      parcelName: session.metadata.parcelName,
      transactionId,
      paymentStatus: session.payment_status,
      paidAt: new Date(),
      trackingId: session.metadata.trackingId,
    };
    const paymentResult = await payments.insertOne(payment);
    await logTracking(payment.trackingId, 'parcel_paid');
    res.send({
      success: true,
      modifyParcel: parcelResult,
      trackingId: payment.trackingId,
      transactionId,
      paymentInfo: paymentResult,
    });
  }),
);

app.get(
  '/payments',
  verifyFBToken,
  asyncRoute(async (req, res) => {
    const query = {};
    if (req.query.email) {
      if (req.query.email !== req.decoded_email)
        return res.status(403).send({ message: 'forbidden access' });
      query.customerEmail = req.query.email;
    }
    const payments = await collection('payments');
    res.send(await payments.find(query).sort({ paidAt: -1 }).toArray());
  }),
);

// Rider APIs
app.get(
  '/riders',
  asyncRoute(async (req, res) => {
    const query = {};
    for (const key of ['status', 'district', 'workStatus'])
      if (req.query[key]) query[key] = req.query[key];
    const riders = await collection('riders');
    res.send(await riders.find(query).toArray());
  }),
);

app.get(
  '/riders/delivery-per-day',
  asyncRoute(async (req, res) => {
    const parcels = await collection('parcels');
    res.send(
      await parcels
        .aggregate([
          {
            $match: {
              riderEmail: req.query.email,
              deliveryStatus: 'parcel_delivered',
            },
          },
          {
            $lookup: {
              from: 'trackings',
              localField: 'trackingId',
              foreignField: 'trackingId',
              as: 'parcel_trackings',
            },
          },
          { $unwind: '$parcel_trackings' },
          { $match: { 'parcel_trackings.status': 'parcel_delivered' } },
          {
            $addFields: {
              deliveryDay: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$parcel_trackings.createdAt',
                },
              },
            },
          },
          { $group: { _id: '$deliveryDay', deliveredCount: { $sum: 1 } } },
        ])
        .toArray(),
    );
  }),
);

app.post(
  '/riders',
  asyncRoute(async (req, res) => {
    const riders = await collection('riders');
    res.send(
      await riders.insertOne({
        ...req.body,
        status: 'pending',
        createdAt: new Date(),
      }),
    );
  }),
);

app.patch(
  '/riders/:id',
  verifyFBToken,
  verifyAdmin,
  asyncRoute(async (req, res) => {
    const { status, email } = req.body;
    const riders = await collection('riders');
    const result = await riders.updateOne(
      { _id: objectId(req.params.id) },
      { $set: { status, workStatus: 'available' } },
    );
    if (status === 'approved' && email) {
      const users = await collection('users');
      await users.updateOne({ email }, { $set: { role: 'rider' } });
    }
    res.send(result);
  }),
);

// Tracking APIs
app.get(
  '/trackings/:trackingId/logs',
  asyncRoute(async (req, res) => {
    const trackings = await collection('trackings');
    res.send(
      await trackings
        .find({ trackingId: req.params.trackingId })
        .sort({ createdAt: 1 })
        .toArray(),
    );
  }),
);

// Last-resort error handler: do not expose database, Stripe, or credential details.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500)
    console.error('Request failed', {
      method: req.method,
      path: req.path,
      message: err.message,
    });
  res
    .status(status)
    .send({ message: status === 500 ? 'Internal server error' : err.message });
});

module.exports = app;
