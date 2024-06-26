const express = require("express");
const app = express();
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_SECRET_KEY);
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.rub0a.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();
    const menuCollection = client.db("bistroDb").collection("menu");
    const reviewCollection = client.db("bistroDb").collection("reviews");
    const cartCollection = client.db("bistroDb").collection("carts");
    const userCollection = client.db("bistroDb").collection("users");
    const paymentCollection = client.db("bistroDb").collection("payments");

    console.log("Connected to MongoDB!");

    const verifyToken = async (req, res, next) => {
      const bearer = req.headers.authorization;
      // console.log(bearer);
      if (!bearer) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = bearer.split(" ")[1];

      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (error, decoded) => {
        if (error) {
          return res.status(401).send({ message: "unauthorized access" });
        }
        req.decoded = decoded;
        next();
      });
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await userCollection.findOne({ email: email });
      const isAdmin = user?.role === "admin";
      if (!isAdmin) {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    app.get("/menu", async (req, res) => {
      const result = await menuCollection.find().toArray();
      res.send(result);
    });

    app.get("/menu/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await menuCollection.findOne(query);
      res.send(result);
    });

    app.get("/reviews", async (req, res) => {
      const result = await reviewCollection.find().toArray();
      res.send(result);
    });

    app.get("/carts", async (req, res) => {
      const email = req.query.email;
      const result = await cartCollection.find({ email: email }).toArray();
      res.send(result);
    });

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.get("/users/admin/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const user = await userCollection.findOne({ email: email });
      if (user) {
        const admin = user.role === "admin";
        return res.send({ admin });
      }
    });

    app.get("/payments/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await paymentCollection.find({ email: email }).toArray();
      res.send(result);
    });

    app.get("/admin-stats", verifyToken, verifyAdmin, async (req, res) => {
      const users = await userCollection.estimatedDocumentCount();
      const menuItems = await menuCollection.estimatedDocumentCount();
      const orders = await paymentCollection.estimatedDocumentCount();

      // const payments = await paymentCollection.find().toArray();
      // const revenue = payments.reduce(
      //   (total, payment) => total + payment.price,
      //   0
      // );
      const revenueResult = await paymentCollection
        .aggregate([
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: "$price" },
            },
          },
        ])
        .toArray();
      const revenue = revenueResult[0] ? revenueResult[0].totalRevenue : 0;

      res.send({
        users,
        menuItems,
        orders,
        revenue,
      });
    });

    app.get("/order-stats", async (req, res) => {
      const pipeline = [
        {
          $unwind: "$menuIds",
        },
        {
          $addFields: {
            menuIds: { $toObjectId: "$menuIds" },
          },
        },
        {
          $lookup: {
            from: "menu",
            localField: "menuIds",
            foreignField: "_id",
            as: "menuItems",
          },
        },
        {
          $unwind: "$menuItems",
        },
        {
          $group: {
            _id: "$menuItems.category",
            totalQuantity: { $sum: 1 },
            totalRevenue: { $sum: "$menuItems.price" },
          },
        },
        {
          $project: {
            _id: 0,
            category: "$_id",
            totalQuantity: 1,
            totalRevenue: 1,
          },
        },
      ];
      const result = await paymentCollection.aggregate(pipeline).toArray();
      res.json(result);
    });

    app.post("/carts", async (req, res) => {
      const cartItem = req.body;
      const result = await cartCollection.insertOne(cartItem);
      res.send(result);
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });
      res.send({ token });
    });

    app.post("/menu", verifyToken, verifyAdmin, async (req, res) => {
      const item = req.body;
      const result = await menuCollection.insertOne(item);
      res.send(result);
    });

    app.patch(
      "/users/admin/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: "admin",
          },
        };
        const result = await userCollection.updateOne(query, updatedDoc);
        res.send(result);
      }
    );

    app.patch("/menu/:id", async (req, res) => {
      const id = req.params.id;
      const item = req.body;
      const { name, category, recipe, price } = item;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          name,
          category,
          recipe,
          price,
        },
      };
      const result = await menuCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    app.delete("/carts/:id", async (req, res) => {
      const cartId = req.params.id;
      const query = { _id: new ObjectId(cartId) };
      const result = await cartCollection.deleteOne(query);
      res.send(result);
    });

    app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await userCollection.deleteOne(query);
      res.send(result);
    });

    app.delete("/menu/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await menuCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.post("/create-payment-intent", async (req, res) => {
      const { price } = req.body;
      const amount = parseFloat(price * 100);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    app.post("/payments", async (req, res) => {
      const payment = req.body;
      const paymentResult = await paymentCollection.insertOne(payment);
      const query = {
        _id: {
          $in: payment.cartIds.map((id) => new ObjectId(id)),
        },
      };
      const deleteResult = await cartCollection.deleteMany(query);

      res.send({ paymentResult, deleteResult });
    });
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Buy Food");
});

app.listen(port, () => {
  console.log("Bistro boss on port:", port);
});
