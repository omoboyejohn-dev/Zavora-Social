const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.database();

exports.purchaseProduct = functions.https.onCall(async (data, context) => {

    // ==========================================
    // AUTHENTICATION
    // ==========================================

    if (!context.auth) {
        throw new functions.https.HttpsError(
            "unauthenticated",
            "You must be logged in to make a purchase."
        );
    }

    const uid = context.auth.uid;
    const email = context.auth.token.email || "";


    // ==========================================
    // PRODUCT ID
    // ==========================================

    const productId =
        typeof data?.productId === "string"
            ? data.productId.trim()
            : "";

    if (!productId) {
        throw new functions.https.HttpsError(
            "invalid-argument",
            "Product ID is required."
        );
    }


    // ==========================================
    // REFERENCES
    // ==========================================

    const productRef =
        db.ref(`products/${productId}`);

    const userRef =
        db.ref(`users/${uid}`);

    const inventoryRef =
        db.ref(`inventory/${productId}`);


    // ==========================================
    // LOAD PRODUCT
    // ==========================================

    const productSnapshot =
        await productRef.once("value");

    if (!productSnapshot.exists()) {
        throw new functions.https.HttpsError(
            "not-found",
            "This product does not exist."
        );
    }

    const product =
        productSnapshot.val();


    // ==========================================
    // PRODUCT STATUS
    // ==========================================

    if (product.active !== true) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "This product is currently unavailable."
        );
    }


    const price =
        Number(product.price || 0);


    if (!Number.isFinite(price) || price <= 0) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "This product has an invalid price."
        );
    }


    // ==========================================
    // TRANSACTION
    //
    // Everything below that changes wallet,
    // inventory and order must be protected
    // against simultaneous purchases.
    // ==========================================

    const result =
        await db.ref().transaction((root) => {

            if (!root) {
                return;
            }


            const user =
                root.users?.[uid] || {};

            const inventory =
                root.inventory?.[productId] || {};

            const orders =
                root.orders || {};


            // ==================================
            // WALLET
            // ==================================

            const walletBalance =
                Number(user.walletBalance || 0);


            if (
                !Number.isFinite(walletBalance) ||
                walletBalance < price
            ) {
                return;
            }


            // ==================================
            // FIND AVAILABLE INVENTORY ITEM
            // ==================================

            let selectedItemId = null;
            let selectedItem = null;


            for (const itemId of Object.keys(inventory)) {

                const item =
                    inventory[itemId];


                if (
                    item &&
                    item.status === "available" &&
                    typeof item.details === "string" &&
                    item.details.trim() !== ""
                ) {

                    selectedItemId =
                        itemId;

                    selectedItem =
                        item;

                    break;

                }

            }


            if (!selectedItemId || !selectedItem) {
                return;
            }


            // ==================================
            // FIND AN ORDER ID
            // ==================================

            const orderId =
                `ORD-${Date.now()}-${Math.random()
                    .toString(36)
                    .substring(2, 8)
                    .toUpperCase()}`;


            // ==================================
            // DEDUCT WALLET
            // ==================================

            const newBalance =
                walletBalance - price;


            root.users[uid] = {
                ...user,
                walletBalance:
                    Number(newBalance.toFixed(2))
            };


            // ==================================
            // MARK INVENTORY AS SOLD
            // ==================================

            root.inventory[productId][selectedItemId] = {

                ...selectedItem,

                status: "sold",

                soldTo: uid,

                soldToEmail: email,

                soldAt: admin.database.ServerValue.TIMESTAMP,

                orderId: orderId

            };


            // ==================================
            // CREATE ORDER
            // ==================================

            root.orders[orderId] = {

                uid: uid,

                email: email,

                productId: productId,

                productName:
                    product.name || "Product",

                category:
                    product.category || "Product",

                amount: price,

                paymentMethod: "Wallet",

                itemDetails:
                    selectedItem.details,

                inventoryItemId:
                    selectedItemId,

                status: "completed",

                createdAt:
                    admin.database.ServerValue.TIMESTAMP

            };


            return root;

        });


    // ==========================================
    // TRANSACTION RESULT
    // ==========================================

    if (!result.committed) {

        const walletSnapshot =
            await userRef
                .child("walletBalance")
                .once("value");

        const currentBalance =
            Number(
                walletSnapshot.val() || 0
            );


        if (currentBalance < price) {

            throw new functions.https.HttpsError(
                "failed-precondition",
                "Insufficient wallet balance."
            );

        }


        const inventorySnapshot =
            await inventoryRef.once("value");

        let available = false;


        if (inventorySnapshot.exists()) {

            inventorySnapshot.forEach((child) => {

                const item =
                    child.val();

                if (
                    item &&
                    item.status === "available" &&
                    typeof item.details === "string" &&
                    item.details.trim() !== ""
                ) {

                    available = true;

                }

            });

        }


        if (!available) {

            throw new functions.https.HttpsError(
                "failed-precondition",
                "This product is currently out of stock."
            );

        }


        throw new functions.https.HttpsError(
            "aborted",
            "The purchase could not be completed. Please try again."
        );

    }


    // ==========================================
    // GET THE COMPLETED ORDER
    // ==========================================

    const orderSnapshot =
        await db
            .ref(`orders`)
            .orderByChild("uid")
            .equalTo(uid)
            .once("value");


    let completedOrder = null;


    orderSnapshot.forEach((child) => {

        const order =
            child.val();


        if (
            order &&
            order.productId === productId &&
            order.status === "completed"
        ) {

            if (
                !completedOrder ||
                Number(order.createdAt || 0) >
                Number(completedOrder.createdAt || 0)
            ) {

                completedOrder = {
                    id: child.key,
                    ...order
                };

            }

        }

    });


    if (!completedOrder) {

        throw new functions.https.HttpsError(
            "internal",
            "Purchase completed, but the order could not be loaded."
        );

    }


    // ==========================================
    // RETURN RESULT
    // ==========================================

    return {

        success: true,

        orderId:
            completedOrder.id,

        productId:
            completedOrder.productId,

        productName:
            completedOrder.productName,

        amount:
            completedOrder.amount,

        itemDetails:
            completedOrder.itemDetails,

        status:
            completedOrder.status

    };

});
