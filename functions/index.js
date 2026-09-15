const {
  onCall,
  HttpsError
} = require("firebase-functions/v2/https");

const {
  initializeApp
} = require("firebase-admin/app");

const {
  getDatabase
} = require("firebase-admin/database");


// ============================================
// FIREBASE ADMIN INITIALIZATION
// ============================================

initializeApp({
  databaseURL:
    "https://zavorasocial-default-rtdb.firebaseio.com/"
});

const db = getDatabase();


// ============================================
// PURCHASE PRODUCT
// ============================================

exports.purchaseProduct = onCall(
  {
    region: "us-central1"
  },

  async (request) => {

    let walletRef = null;
    let inventoryItemRef = null;
    let price = 0;
    let inventoryReserved = false;
    let walletCharged = false;


    try {

      // ========================================
      // CHECK LOGIN
      // ========================================

      if (!request.auth) {

        throw new HttpsError(
          "unauthenticated",
          "You must be logged in to purchase a product."
        );

      }


      const uid =
        request.auth.uid;

      const email =
        request.auth.token?.email || "";


      // ========================================
      // GET PRODUCT ID
      // ========================================

      const productId =
        request.data?.productId;


      if (!productId) {

        throw new HttpsError(
          "invalid-argument",
          "Product ID is required."
        );

      }


      // ========================================
      // LOAD PRODUCT
      // ========================================

      const productRef =
        db.ref(
          `products/${productId}`
        );


      const productSnapshot =
        await productRef.once("value");


      if (!productSnapshot.exists()) {

        throw new HttpsError(
          "not-found",
          "Product does not exist."
        );

      }


      const product =
        productSnapshot.val();


      // ========================================
      // CHECK PRODUCT STATUS
      // ========================================

      if (
        product.active === false
      ) {

        throw new HttpsError(
          "failed-precondition",
          "This product is currently unavailable."
        );

      }


      // ========================================
      // CHECK PRICE
      // ========================================

      price =
        Number(product.price);


      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {

        throw new HttpsError(
          "failed-precondition",
          "This product has an invalid price."
        );

      }


      // ========================================
      // FIND AVAILABLE INVENTORY
      // ========================================

      const inventoryRef =
        db.ref(
          `inventory/${productId}`
        );


      const inventorySnapshot =
        await inventoryRef
          .orderByChild("status")
          .equalTo("available")
          .limitToFirst(1)
          .once("value");


      if (
        !inventorySnapshot.exists()
      ) {

        throw new HttpsError(
          "failed-precondition",
          "This product is currently out of stock."
        );

      }


      const inventoryData =
        inventorySnapshot.val();


      const inventoryIds =
        Object.keys(
          inventoryData || {}
        );


      if (
        inventoryIds.length === 0
      ) {

        throw new HttpsError(
          "failed-precondition",
          "This product is currently out of stock."
        );

      }


      const inventoryId =
        inventoryIds[0];


      const inventoryItem =
        inventoryData[inventoryId];


      if (!inventoryItem) {

        throw new HttpsError(
          "failed-precondition",
          "The inventory item could not be found."
        );

      }


      inventoryItemRef =
        db.ref(
          `inventory/${productId}/${inventoryId}`
        );


      // ========================================
      // RESERVE INVENTORY ITEM
      // ========================================

      const reserveResult =
        await inventoryItemRef.transaction(
          (currentItem) => {

            if (!currentItem) {
              return;
            }


            if (
              currentItem.status !==
              "available"
            ) {

              return;

            }


            return {
              ...currentItem,

              status:
                "processing",

              processingBy:
                uid,

              processingAt:
                Date.now()

            };

          }
        );


      if (
        !reserveResult.committed
      ) {

        throw new HttpsError(
          "aborted",
          "The inventory item was just purchased by another customer. Please try again."
        );

      }


      inventoryReserved = true;


      // ========================================
      // CHECK WALLET
      // ========================================

      walletRef =
        db.ref(
          `users/${uid}/walletBalance`
        );


      let previousBalance = 0;


      const walletResult =
        await walletRef.transaction(
          (currentBalance) => {

            const balance =
              Number(
                currentBalance
              ) || 0;


            previousBalance =
              balance;


            if (
              balance < price
            ) {

              return;

            }


            return balance - price;

          }
        );


      // ========================================
      // INSUFFICIENT BALANCE
      // ========================================

      if (
        !walletResult.committed
      ) {

        // Release inventory

        await inventoryItemRef.transaction(
          (currentItem) => {

            if (
              !currentItem ||
              currentItem.processingBy !== uid
            ) {

              return;

            }


            return {
              ...currentItem,

              status:
                "available",

              processingBy:
                null,

              processingAt:
                null

            };

          }
        );


        inventoryReserved = false;


        throw new HttpsError(
          "failed-precondition",

          `Insufficient wallet balance. Your balance is ₦${previousBalance.toLocaleString("en-NG")}.`
        );

      }


      walletCharged = true;


      // ========================================
      // CREATE ORDER
      // ========================================

      const orderRef =
        db.ref("orders").push();


      const deliveryDetails =
        inventoryItem.details ??
        "";


      const order = {

        uid:
          uid,

        email:
          email,

        productId:
          productId,

        productName:
          product.name ||
          "Unnamed Product",

        price:
          price,

        category:
          product.category ||
          "Product",

        image:
          product.image ||
          "",

        description:
          product.description ||
          "",

        status:
          "completed",

        deliveryStatus:
          "delivered",

        deliveryDetails:
          deliveryDetails,

        inventoryId:
          inventoryId,

        createdAt:
          Date.now()

      };


      // ========================================
      // SAVE ORDER
      // ========================================

      try {

        await orderRef.set(
          order
        );

      } catch (error) {

        console.error(
          "ORDER CREATION ERROR:",
          error
        );


        // ==============================
        // REFUND WALLET
        // ==============================

        if (walletCharged) {

          await walletRef.transaction(
            (currentBalance) => {

              const balance =
                Number(
                  currentBalance
                ) || 0;


              return (
                balance +
                price
              );

            }
          );

          walletCharged = false;

        }


        // ==============================
        // RELEASE INVENTORY
        // ==============================

        if (
          inventoryReserved &&
          inventoryItemRef
        ) {

          await inventoryItemRef.transaction(
            (currentItem) => {

              if (
                !currentItem ||
                currentItem.processingBy !== uid
              ) {

                return;

              }


              return {
                ...currentItem,

                status:
                  "available",

                processingBy:
                  null,

                processingAt:
                  null

              };

            }
          );

          inventoryReserved = false;

        }


        throw new HttpsError(
          "internal",
          "The order could not be created. Your money has been refunded."
        );

      }


      // ========================================
      // MARK INVENTORY AS SOLD
      // ========================================

      try {

        const soldResult =
          await inventoryItemRef.transaction(
            (currentItem) => {

              if (!currentItem) {
                return;
              }


              if (
                currentItem.processingBy !== uid
              ) {

                return;

              }


              return {

                ...currentItem,

                status:
                  "sold",

                soldTo:
                  uid,

                soldOrderId:
                  orderRef.key,

                soldAt:
                  Date.now(),

                processingBy:
                  null,

                processingAt:
                  null

              };

            }
          );


        if (
          !soldResult.committed
        ) {

          console.error(
            "Inventory was not marked as sold:",
            inventoryId
          );

        }


      } catch (error) {

        console.error(
          "INVENTORY SOLD UPDATE ERROR:",
          error
        );

      }


      inventoryReserved = false;
      walletCharged = false;


      // ========================================
      // SUCCESS
      // ========================================

      return {

        success:
          true,

        orderId:
          orderRef.key,

        productName:
          product.name ||
          "Unnamed Product",

        price:
          price,

        deliveryDetails:
          deliveryDetails,

        message:
          "Purchase completed successfully."

      };

    } catch (error) {

      // ========================================
      // KEEP KNOWN FIREBASE ERRORS
      // ========================================

      if (
        error instanceof HttpsError
      ) {

        throw error;

      }


      // ========================================
      // UNEXPECTED ERROR
      // ========================================

      console.error(
        "PURCHASE PRODUCT ERROR:",
        error
      );


      // ========================================
      // REFUND IF MONEY WAS CHARGED
      // ========================================

      if (
        walletCharged &&
        walletRef
      ) {

        try {

          await walletRef.transaction(
            (currentBalance) => {

              const balance =
                Number(
                  currentBalance
                ) || 0;


              return (
                balance +
                price
              );

            }
          );

        } catch (refundError) {

          console.error(
            "REFUND ERROR:",
            refundError
          );

        }

      }


      // ========================================
      // RELEASE INVENTORY
      // ========================================

      if (
        inventoryReserved &&
        inventoryItemRef
      ) {

        try {

          await inventoryItemRef.transaction(
            (currentItem) => {

              if (
                !currentItem ||
                !request.auth ||
                currentItem.processingBy !==
                  request.auth.uid
              ) {

                return;

              }


              return {

                ...currentItem,

                status:
                  "available",

                processingBy:
                  null,

                processingAt:
                  null

              };

            }
          );

        } catch (releaseError) {

          console.error(
            "INVENTORY RELEASE ERROR:",
            releaseError
          );

        }

      }


      // ========================================
      // RETURN USEFUL ERROR
      // ========================================

      const errorMessage =
        error?.message ||
        "An unexpected error occurred while processing your purchase.";


      throw new HttpsError(
        "internal",
        `Purchase failed: ${errorMessage}`
      );

    }

  }
);
