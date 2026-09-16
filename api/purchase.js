const {
  initializeApp,
  cert,
  getApps,
} = require("firebase-admin/app");

const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");

// Initialize Firebase Admin only once
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    databaseURL:
      "https://zavorasocial-default-rtdb.firebaseio.com/",
  });
}

const db = getDatabase();
const auth = getAuth();

module.exports = async function handler(req, res) {
  // Only POST is allowed
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed.",
    });
  }

  let reservedInventoryRef = null;
  let walletRef = null;
  let price = 0;
  let walletDeducted = false;

  try {
    // --------------------------------------------------
    // 1. Verify Firebase login
    // --------------------------------------------------

    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "You must be logged in.",
      });
    }

    const idToken = authorization.substring(7);

    const decodedToken = await auth.verifyIdToken(idToken);

    const uid = decodedToken.uid;
    const email = decodedToken.email || "";

    // --------------------------------------------------
    // 2. Get product ID
    // --------------------------------------------------

    const productId = String(req.body?.productId || "").trim();

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required.",
      });
    }

    // --------------------------------------------------
    // 3. Read product from Firebase
    // --------------------------------------------------

    const productRef = db.ref(`products/${productId}`);
    const productSnapshot = await productRef.once("value");

    if (!productSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    const product = productSnapshot.val();

    if (product.active === false) {
      return res.status(400).json({
        success: false,
        message: "This product is currently unavailable.",
      });
    }

    price = Number(product.price);

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(500).json({
        success: false,
        message: "This product has an invalid price.",
      });
    }

    // --------------------------------------------------
    // 4. Find an available inventory item
    // --------------------------------------------------

    const inventoryRef = db.ref(`inventory/${productId}`);

    const inventorySnapshot = await inventoryRef
      .orderByChild("status")
      .equalTo("available")
      .limitToFirst(10)
      .once("value");

    const inventoryItems = inventorySnapshot.val() || {};

    let inventoryId = null;
    let inventoryItem = null;

    // Try several available items in case another
    // customer purchases one at the same time.
    for (const [id, item] of Object.entries(inventoryItems)) {
      const itemRef = inventoryRef.child(id);

      const transaction = await itemRef.transaction((current) => {
        if (!current || current.status !== "available") {
          return;
        }

        return {
          ...current,
          status: "processing",
          processingBy: uid,
          processingAt: Date.now(),
        };
      });

      if (transaction.committed) {
        inventoryId = id;
        inventoryItem = transaction.snapshot.val();
        reservedInventoryRef = itemRef;
        break;
      }
    }

    if (!inventoryId || !inventoryItem) {
      return res.status(409).json({
        success: false,
        message: "This product is currently out of stock.",
      });
    }

    // --------------------------------------------------
    // 5. Deduct money from customer's wallet
    // --------------------------------------------------

    walletRef = db.ref(`users/${uid}/walletBalance`);

    const walletTransaction = await walletRef.transaction((current) => {
      const balance = Number(current) || 0;

      if (balance < price) {
        return;
      }

      return balance - price;
    });

    if (!walletTransaction.committed) {
      // Release the inventory item because payment failed.
      await reservedInventoryRef.transaction((current) => {
        if (
          current &&
          current.status === "processing" &&
          current.processingBy === uid
        ) {
          return {
            ...current,
            status: "available",
            processingBy: null,
            processingAt: null,
          };
        }

        return current;
      });

      const currentWalletSnapshot = await walletRef.once("value");
      const currentBalance =
        Number(currentWalletSnapshot.val()) || 0;

      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Your balance is ₦${currentBalance.toLocaleString()}.`,
        balance: currentBalance,
        price,
      });
    }

    walletDeducted = true;

    // --------------------------------------------------
    // 6. Create the order
    // --------------------------------------------------

    const orderRef = db.ref("orders").push();

    const order = {
      uid,
      email,

      productId,
      productName: product.name || "",
      price,

      category: product.category || "",
      image: product.image || "",
      description: product.description || "",

      status: "completed",
      deliveryStatus: "delivered",

      deliveryDetails: inventoryItem.details || "",

      inventoryId,

      createdAt: Date.now(),
    };

    await orderRef.set(order);

    // --------------------------------------------------
    // 7. Mark inventory item as sold
    // --------------------------------------------------

    const soldTransaction = await reservedInventoryRef.transaction(
      (current) => {
        if (
          !current ||
          current.status !== "processing" ||
          current.processingBy !== uid
        ) {
          return;
        }

        return {
          ...current,

          status: "sold",

          soldTo: uid,
          soldEmail: email,
          soldOrderId: orderRef.key,
          soldAt: Date.now(),

          processingBy: null,
          processingAt: null,
        };
      }
    );

    if (!soldTransaction.committed) {
      console.error(
        "Order created but inventory could not be marked sold:",
        inventoryId
      );
    }

    // --------------------------------------------------
    // 8. Return successful purchase
    // --------------------------------------------------

    const newBalance =
      Number(walletTransaction.snapshot.val()) || 0;

    return res.status(200).json({
      success: true,

      message: "Purchase successful!",

      orderId: orderRef.key,

      productId,
      productName: product.name || "",

      price,

      balance: newBalance,

      inventoryId,

      deliveryDetails: inventoryItem.details || "",

      order: {
        ...order,
        orderId: orderRef.key,
      },
    });
  } catch (error) {
    console.error("Purchase API error:", error);

    // --------------------------------------------------
    // Emergency rollback
    // --------------------------------------------------

    try {
      // Return inventory to available if it was reserved.
      if (reservedInventoryRef) {
        await reservedInventoryRef.transaction((current) => {
          if (
            current &&
            current.status === "processing"
          ) {
            return {
              ...current,
              status: "available",
              processingBy: null,
              processingAt: null,
            };
          }

          return current;
        });
      }

      // Refund wallet if money was already deducted.
      if (walletDeducted && walletRef && price > 0) {
        await walletRef.transaction((current) => {
          const balance = Number(current) || 0;
          return balance + price;
        });
      }
    } catch (rollbackError) {
      console.error(
        "Rollback error:",
        rollbackError
      );
    }

    return res.status(500).json({
      success: false,
      message:
        "Something went wrong while processing your purchase. Please try again.",
    });
  }
};
