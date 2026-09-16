const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
// ----------------------------------------------------
// Firebase Admin setup
// ----------------------------------------------------
if (!getApps().length) {
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
  // Vercel may store the \n characters literally.
  privateKey = privateKey.replace(/\\n/g, "\n");
  // Remove accidental surrounding quotes if they were pasted.
  if (
    privateKey.startsWith('"') &&
    privateKey.endsWith('"')
  ) {
    privateKey = privateKey.slice(1, -1);
  }
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL:
      "https://zavorasocial-default-rtdb.firebaseio.com/",
  });
}
const db = getDatabase();
const adminAuth = getAuth();
// ----------------------------------------------------
// API
// ----------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed.",
    });
  }
  let reservedInventoryRef = null;
  let walletRef = null;
  let chargedAmount = 0;
  let orderRef = null;
  try {
    // ------------------------------------------------
    // 1. Verify Firebase login
    // ------------------------------------------------
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "You must be logged in.",
      });
    }
    const idToken = authHeader.substring(7).trim();
    if (!idToken) {
      return res.status(401).json({
        success: false,
        message: "Missing authentication token.",
      });
    }
    const decodedToken = await adminAuth.verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const email = decodedToken.email || "";
    // ------------------------------------------------
    // 2. Read product ID
    // ------------------------------------------------
    const productId = String(
      req.body && req.body.productId
        ? req.body.productId
        : ""
    ).trim();
    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required.",
      });
    }
    // ------------------------------------------------
    // 3. Get product from Firebase
    // ------------------------------------------------
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
    const price = Number(product.price);
    if (!Number.isFinite(price) || price <= 0) {
      console.error("Invalid product price:", product.price);
      return res.status(500).json({
        success: false,
        message: "This product has an invalid price.",
      });
    }
    chargedAmount = price;
    // ------------------------------------------------
    // 4. Find available inventory
    // ------------------------------------------------
    const inventoryRef = db.ref(`inventory/${productId}`);
    const inventorySnapshot = await inventoryRef
      .orderByChild("status")
      .equalTo("available")
      .limitToFirst(10)
      .once("value");
    const inventory = inventorySnapshot.val();
    if (!inventory) {
      return res.status(409).json({
        success: false,
        message: "This product is out of stock.",
      });
    }
    // ------------------------------------------------
    // 5. Reserve ONE inventory item
    // ------------------------------------------------
    let reservedInventory = null;
    for (const [inventoryId, item] of Object.entries(inventory)) {
      const itemRef = inventoryRef.child(inventoryId);
      const reservation = await itemRef.transaction((current) => {
        if (!current) {
          return;
        }
        if (current.status !== "available") {
          return;
        }
        return {
          ...current,
          status: "processing",
          processingBy: uid,
          processingAt: Date.now(),
        };
      });
      if (reservation.committed) {
        reservedInventoryRef = itemRef;
        reservedInventory = reservation.snapshot.val();
        break;
      }
    }
    if (!reservedInventoryRef || !reservedInventory) {
      return res.status(409).json({
        success: false,
        message:
          "That inventory item was just purchased by another customer. Please try again.",
      });
    }
    // ------------------------------------------------
    // 6. Deduct wallet balance safely
    // ------------------------------------------------
    walletRef = db.ref(`users/${uid}/walletBalance`);
    const walletTransaction = await walletRef.transaction(
      (currentBalance) => {
        const balance = Number(currentBalance) || 0;
        if (balance < price) {
          return;
        }
        return balance - price;
      }
    );
    if (!walletTransaction.committed) {
      // Release inventory because customer could not pay.
      await reservedInventoryRef.transaction((current) => {
        if (
          current &&
          current.status === "processing" &&
          current.processingBy === uid
        ) {
          const released = { ...current };
          released.status = "available";
          delete released.processingBy;
          delete released.processingAt;
          return released;
        }
        return current;
      });
      const currentWalletSnapshot = await walletRef.once("value");
      const currentBalance =
        Number(currentWalletSnapshot.val()) || 0;
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Your balance is ${currentBalance}. Product price is ${price}.`,
        balance: currentBalance,
        price,
      });
    }
    // ------------------------------------------------
    // 7. Create order as processing
    // ------------------------------------------------
    orderRef = db.ref("orders").push();
    const orderId = orderRef.key;
    const order = {
      uid,
      email,
      productId,
      productName: product.name || "",
      price,
      category: product.category || "",
      image: product.image || "",
      description: product.description || "",
      status: "processing",
      deliveryStatus: "processing",
      deliveryDetails:
        reservedInventory.details ||
        reservedInventory.deliveryDetails ||
        "",
      inventoryId: reservedInventoryRef.key,
      createdAt: Date.now(),
    };
    await orderRef.set(order);
    // ------------------------------------------------
    // 8. Mark inventory as sold
    // ------------------------------------------------
    const soldTransaction = await reservedInventoryRef.transaction(
      (current) => {
        if (!current) {
          return;
        }
        if (
          current.status !== "processing" ||
          current.processingBy !== uid
        ) {
          return;
        }
        const sold = { ...current };
        sold.status = "sold";
        sold.soldTo = uid;
        sold.soldOrderId = orderId;
        sold.soldAt = Date.now();
        delete sold.processingBy;
        delete sold.processingAt;
        return sold;
      }
    );
    if (!soldTransaction.committed) {
      throw new Error("Could not finalize inventory item.");
    }
    // ------------------------------------------------
    // 9. Complete the order
    // ------------------------------------------------
    await orderRef.update({
      status: "completed",
      deliveryStatus: "delivered",
      completedAt: Date.now(),
    });
    // ------------------------------------------------
    // 10. Return purchase result
    // ------------------------------------------------
    const finalWalletSnapshot = await walletRef.once("value");
    const finalBalance =
      Number(finalWalletSnapshot.val()) || 0;
    return res.status(200).json({
      success: true,
      message: "Purchase successful!",
      orderId,
      productId,
      productName: product.name || "",
      price,
      deliveryDetails:
        reservedInventory.details ||
        reservedInventory.deliveryDetails ||
        "",
      balance: finalBalance,
    });
  } catch (error) {
    console.error("PURCHASE ERROR:", error);
    // ------------------------------------------------
    // Roll back if something failed after reservation
    // ------------------------------------------------
    try {
      if (reservedInventoryRef) {
        await reservedInventoryRef.transaction((current) => {
          if (
            current &&
            current.status === "processing" &&
            current.processingBy
          ) {
            const released = { ...current };
            released.status = "available";
            delete released.processingBy;
            delete released.processingAt;
            return released;
          }
          return current;
        });
      }
    } catch (rollbackError) {
      console.error(
        "INVENTORY ROLLBACK ERROR:",
        rollbackError
      );
    }
    // ------------------------------------------------
    // Refund wallet if it was charged
    // ------------------------------------------------
    try {
      if (walletRef && chargedAmount > 0) {
        await walletRef.transaction((currentBalance) => {
          const balance = Number(currentBalance) || 0;
          return balance + chargedAmount;
        });
      }
    } catch (refundError) {
      console.error("WALLET REFUND ERROR:", refundError);
    }
    // ------------------------------------------------
    // Remove incomplete order
    // ------------------------------------------------
    try {
      if (orderRef) {
        await orderRef.remove();
      }
    } catch (orderCleanupError) {
      console.error(
        "ORDER CLEANUP ERROR:",
        orderCleanupError
      );
    }
    return res.status(500).json({
      success: false,
      message:
        "Purchase could not be completed. Your wallet and inventory were protected.",
    });
  }
};
