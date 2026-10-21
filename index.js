const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();
const port = process.env.PORT || 3000;

const crypto = require('crypto');

// var admin = require('firebase-admin');

// ============= // This is for destructuring objects from firebase-admin/app.
const { initializeApp, cert } = require('firebase-admin/app');

// ============= // This is for destructuring objects from firebase-admin/auth.
const { getAuth } = require('firebase-admin/auth');

// var serviceAccount = require('./zap-shift-firebase-adminsdk.json');

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString(
    'utf8',
  ),
);

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });

initializeApp({
  // It takes your Firebase service-account JSON data and makes it into a valid credential Firebase Admin can use.
  credential: cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = 'PRCL'; // your brand prefix
  // const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const date = new Date().toISOString().slice(0, 10).replaceAll(/-/g, '');
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();

  // return `PCL-${date}-${random}`;
  return `${prefix}-${date}-${random}`;
}

const stripe = require('stripe')(process.env.STRIPE_SECRET);
// const paymentDomain = process.env.SITE_DOMAIN;

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  // console.log('headers in the middleware', req.headers?.authorization);

  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' });
  }

  try {
    const idToken = token.split(' ')[1];
    const decoded = await getAuth().verifyIdToken(idToken);
    console.log('decoded in the token', decoded);
    req.decoded_email = decoded.email;
  } catch (err) {
    return res.status(401).send({ message: 'unauthorized access' });
  }

  next();
};

const uri = process.env.URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ==============================================
async function run() {
  try {
    await client.connect();

    // ==============================================
    //DB & collections
    const db = client.db('zap_shift_db');
    const usersCollection = db.collection('users');
    const parcelsCollection = db.collection('parcels');
    const paymentCollection = db.collection('payments');
    const ridersCollection = db.collection('riders');
    const trackingsCollection = db.collection('trackings');

    // middleware admin before allowing admin activity
    // must be used after verifyFBToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    };

    const verifyRider = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== 'rider') {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    };

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split('_').join(' '),
        createdAt: new Date(),
      };

      const result = await trackingsCollection.insertOne(log);
      return result;
    };

    // user related apis
    app.get('/users', verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        // search by mongoDB query
        // $regex = regular expression, searchText = pattarn, $options: 'i' = ignore letter case sensitivity
        // query.displayName = { $regex: searchText, $options: 'i' };

        query.$or = [
          { displayName: { $regex: searchText, $options: 'i' } },
          { email: { $regex: searchText, $options: 'i' } },
        ];
      }

      const cursor = usersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(5);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get('/users/:id', async (req, res) => {});

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || 'user' });
    });

    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'user';
      user.createdAt = new Date();

      const email = user.email;
      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        return res.send({ message: 'user exists' });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.patch(
      '/users/:id/role',
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await usersCollection.updateOne(query, updatedDoc);
        res.send(result);
      },
    );

    // parcel api
    app.get('/parcels', async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      // /parcels?email=''&

      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get('/parcels/rider', async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }
      if (deliveryStatus !== 'parcel_delivered') {
        // query.deliveryStatus = { $in: ['driver_assigned', 'rider_arriving'] };
        query.deliveryStatus = { $nin: ['parcel_delivered'] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }

      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();

      res.send(result);
    });

    app.get('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.get('/parcels/delivery-status/stats', async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: '$deliveryStatus',
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: '$_id',
            count: 1,
            _id: 0,
          },
        },
      ];
      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.post('/parcels', async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId();

      // parcel created time
      parcel.createdAt = new Date();
      parcel.trackingId = trackingId;

      logTracking(trackingId, 'parcel_created');

      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    // TODO: rename this to be specific like /parcel/:id/assign
    app.patch('/parcels/:id', async (req, res) => {
      const { riderId, riderName, riderEmail, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updatedDoc = {
        $set: {
          deliveryStatus: 'driver_assigned',
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };

      const result = await parcelsCollection.updateOne(query, updatedDoc);

      // update rider information
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: 'in_delivery',
        },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdatedDoc,
      );

      // log tracking
      logTracking(trackingId, 'driver_assigned');

      res.send(riderResult);
    });

    app.patch('/parcels/:id/status', async (req, res) => {
      const { deliveryStatus, riderId, trackingId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };

      if (deliveryStatus === 'parcel_delivered') {
        // update rider information
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdatedDoc = {
          $set: {
            workStatus: 'available',
          },
        };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          riderUpdatedDoc,
        );

        res.send(riderResult);
      }

      const result = await parcelsCollection.updateOne(query, updatedDoc);

      // log tracking
      logTracking(trackingId, deliveryStatus);
      res.send(result);
    });

    app.delete('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // payment related APIs
    app.post('/payment-checkout-session', async (req, res) => {
      const parcelInfo = req.body;
      const amount = parseInt(parcelInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: amount,
              product_data: {
                name: `please pay for ${parcelInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        metadata: {
          parcelId: parcelInfo.parcelId,
          parcelName: parcelInfo.parcelName,
          trackingId: parcelInfo.trackingId,
        },
        customer_email: parcelInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
        // Provide a name (for example, hosted_web_0001) to label this Checkout integration and measure its conversion independently
        // integration_identifier: '{{INTEGRATION_ID}}',
      });
      // res.redirect(303, session.url);
      res.send({ url: session.url });
    });

    // old
    // app.post('/create-checkout-session', async (req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;

    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         // Provide the exact Price ID (for example, price_1234) of the product you want to sell
    //         // price: '{{PRICE_ID}}',
    //         // ==========  or ==============
    //         // Provide the Price data (for example, price_data: {
    //         //   currency: 'USD',
    //         //   unit_amount: amount,
    //         //   product_data: {
    //         //     name: paymentInfo.parcelName,
    //         //   },
    //         // },) of the product you want to sell

    //         price_data: {
    //           currency: 'USD',
    //           // currency: 'BDT',
    //           unit_amount: amount,
    //           product_data: {
    //             name: paymentInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     mode: 'payment',
    //     metadata: {
    //       parcelId: paymentInfo.parcelId,
    //       parcelName: paymentInfo.parcelName,
    //     },
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,

    //     // Provide a name (for example, hosted_web_0001) to label this Checkout integration and measure its conversion independently
    //     // integration_identifier: '{{INTEGRATION_ID}}',
    //   });
    //   console.log(session);
    //   res.send({ url: session.url });
    // });

    app.patch('/payment-success', async (req, res) => {
      const sessionId = req.query.session_id;
      // console.log('session id', sessionId);

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      console.log('session retrieve', session);

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);
      // console.log(paymentExist);
      if (paymentExist) {
        return res.send({
          message: 'already exists',
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
      // const trackingId = generateTrackingId();
      const trackingId = session.metadata.trackingId;

      if (session.payment_status === 'paid') {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: 'paid',
            deliveryStatus: 'pending-pickup',
            // trackingId: trackingId, // no need to add it this time
          },
        };
        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        const resultPayment = await paymentCollection.insertOne(payment);

        logTracking(trackingId, 'parcel_paid');

        return res.send({
          success: true,
          modifyParcel: result,
          trackingId: trackingId,
          transactionId: session.payment_intent,
          paymentInfo: resultPayment,
        });

        // res.send(result);
      }

      return res.send({ success: false });
    });

    app.get('/payments', verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      console.log('headers', req.headers);

      if (email) {
        query.customerEmail = email;

        // check email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: 'forbidden access' });
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // riders related apis
    app.get('/riders', async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};

      if (status) {
        query.status = status;
      }
      if (district) {
        query.district = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();

      res.send(result);
    });

    app.get('/riders/delivery-per-day', async (req, res) => {
      const email = req.query.email;
      // aggregate on parcel
      const pipeline = [
        {
          $match: {
            riderEmail: email,
            deliveryStatus: 'parcel_delivered',
          },
        },
        {
          $lookup: {
            from: 'trackings',
            localField: 'trackingId',
            foreignField: 'trackingId',
            as: 'parcel_trackings'
          },
        },
      ];

      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.post('/riders', async (req, res) => {
      const rider = req.body;
      rider.status = 'pending';
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          status: status,
          workStatus: 'available',
        },
      };

      const result = await ridersCollection.updateOne(query, updatedDoc);

      if (status === 'approved') {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: 'rider',
          },
        };
        const userResult = await usersCollection.updateOne(
          userQuery,
          updateUser,
        );
        // res.send(userResult);
      }

      res.send(result);
    });

    // tracking related apis
    app.get('/trackings/:trackingId/logs', async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingsCollection.find(query).toArray();
      res.send(result);
    });

    await client.db('admin').command({ ping: 1 });
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.dir(err);
  }
}

// Call this only when your application terminates
// export async function disconnectFromMongoDB() {
//   await client.close();
// }

run();

app.get('/', (req, res) => {
  res.send('Zap is shifting shifting!');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
