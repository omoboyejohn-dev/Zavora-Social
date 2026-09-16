const {
    initializeApp,
    cert,
    getApps
} = require("firebase-admin/app");

const {
    getAuth
} = require("firebase-admin/auth");

const {
    getDatabase
} = require("firebase-admin/database");


/* =========================================================
   FIREBASE ADMIN
========================================================= */

if (!getApps().length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        : "";

    initializeApp({
        credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey
        }),
        databaseURL:
            "https://zavorasocial-default-rtdb.firebaseio.com/"
    });
}

const auth = getAuth();
const db = getDatabase();


/* =========================================================
   HELPERS
========================================================= */

function response(res, status, data) {
    return res.status(status).json(data);
}

function money(value) {
    return Number(value).toLocaleString("en-NG", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function availableItem(item) {
    if (!item || typeof item !== "object") {
        return false;
    }

    const status =
        typeof item.status === "string"
            ? item.status.trim().toLowerCase()
            : "";

    return status === "available" || status === "";
}


/* =========================================================
   MAIN PURCHASE API
========================================================= */

module.exports = async function handler(req, res) {

    if (req.method !== "POST") {
        return response(res, 405, {
            success: false,
            message: "Method not allowed."
        });
    }

    let reservedInventoryId = null;
    let reservedInventory = null;
    let uid = null;
    let price = 0;

    try {

        /* =====================================================
           AUTHENTICATION
        ===================================================== */

        const authorization =
            req.headers.authorization || "";

        if (!authorization.startsWith("Bearer ")) {
            return response(res, 401, {
                success: false,
                message: "Please log in before purchasing."
            });
        }

        const token =
            authorization.substring(7).trim();

        const decoded =
            await auth.verifyIdToken(token);

        uid = decoded.uid;

        const email =
            decoded.email || "";


        /* =====================================================
           PRODUCT ID
        ===================================================== */

        const productId =
            req.body && req.body.productId
                ? String(req.body.productId).trim()
                : "";

        if (!productId) {
            return response(res, 400, {
                success: false,
                message: "Product ID is required."
            });
        }


        console.log("=================================");
        console.log("PURCHASE STARTED");
        console.log("UID:", uid);
        console.log("PRODUCT:", productId);
        console.log("=================================");


        /* =====================================================
           GET PRODUCT
        ===================================================== */

        const productRef =
            db.ref("products/" + productId);

        const productSnapshot =
            await productRef.once("value");

        if (!productSnapshot.exists()) {
            return response(res, 404, {
                success: false,
                message: "Product not found."
            });
        }

        const product =
            productSnapshot.val();

        if (product.active === false) {
            return response(res, 400, {
                success: false,
                message: "This product is currently unavailable."
            });
        }

        price = Number(product.price);

        if (!Number.isFinite(price) || price <= 0) {
            return response(res, 400, {
                success: false,
                message: "This product has an invalid price."
            });
        }

        console.log("PRODUCT PRICE:", price);


        /* =====================================================
           READ INVENTORY
        ===================================================== */

        const inventoryRef =
            db.ref("inventory/" + productId);

        const inventorySnapshot =
            await inventoryRef.once("value");

        if (!inventorySnapshot.exists()) {
            console.log("INVENTORY DOES NOT EXIST");

            return response(res, 409, {
                success: false,
                message:
                    "This product is currently out of stock."
            });
        }

        const inventory =
            inventorySnapshot.val();

        if (!inventory || typeof inventory !== "object") {
            return response(res, 409, {
                success: false,
                message:
                    "This product is currently out of stock."
            });
        }


        /* =====================================================
           FIND AVAILABLE ITEM
        ===================================================== */

        const inventoryEntries =
            Object.entries(inventory);

        console.log(
            "TOTAL INVENTORY:",
            inventoryEntries.length
        );

        let availableCount = 0;

        for (const [inventoryId, item] of inventoryEntries) {

            console.log(
                "INVENTORY ITEM:",
                inventoryId,
                "STATUS:",
                item && item.status
            );

            if (availableItem(item)) {
                availableCount++;
            }
        }

        console.log(
            "AVAILABLE COUNT:",
            availableCount
        );


        if (availableCount === 0) {
            return response(res, 409, {
                success: false,
                message:
                    "This product is currently out of stock."
            });
        }


        /* =====================================================
           SELECT FIRST AVAILABLE ITEM
        ===================================================== */

        for (const [inventoryId, item] of inventoryEntries) {

            if (!availableItem(item)) {
                continue;
            }

            reservedInventoryId =
                inventoryId;

            reservedInventory =
                item;

            break;
        }


        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {
            return response(res, 409, {
                success: false,
                message:
                    "This product is currently out of stock."
            });
        }


        console.log(
            "SELECTED INVENTORY:",
            reservedInventoryId
        );


        /* =====================================================
           READ THE SELECTED ITEM AGAIN
        ===================================================== */

        const selectedItemRef =
            inventoryRef.child(
                reservedInventoryId
            );

        const selectedItemSnapshot =
            await selectedItemRef.once("value");

        if (!selectedItemSnapshot.exists()) {
            return response(res, 409, {
                success: false,
                message:
                    "The selected inventory item is no longer available. Please try again."
            });
        }

        const latestItem =
            selectedItemSnapshot.val();

        if (!availableItem(latestItem)) {

            console.log(
                "SELECTED ITEM NO LONGER AVAILABLE"
            );

            return response(res, 409, {
                success: false,
                message:
                    "That inventory item was just purchased. Please try again."
            });
        }

        reservedInventory =
            latestItem;


        /* =====================================================
           MARK ITEM PROCESSING
        ===================================================== */

        await selectedItemRef.update({

            status: "processing",

            processingBy: uid,

            processingAt: Date.now()
        });


        console.log(
            "INVENTORY MARKED PROCESSING:",
            reservedInventoryId
        );


        /* =====================================================
           WALLET
        ===================================================== */

        const walletRef =
            db.ref(
                "users/" +
                uid +
                "/walletBalance"
            );

        const walletSnapshot =
            await walletRef.once("value");

        if (!walletSnapshot.exists()) {

            await restoreInventory(
                selectedItemRef,
                uid
            );

            return response(res, 400, {
                success: false,
                message:
                    "Your wallet balance could not be found."
            });
        }

        const currentBalance =
            Number(walletSnapshot.val());

        console.log(
            "WALLET BALANCE:",
            currentBalance
        );

        console.log(
            "PRODUCT PRICE:",
            price
        );


        if (!Number.isFinite(currentBalance)) {

            await restoreInventory(
                selectedItemRef,
                uid
            );

            return response(res, 400, {
                success: false,
                message:
                    "Your wallet balance is invalid."
            });
        }


        if (currentBalance < price) {

            await restoreInventory(
                selectedItemRef,
                uid
            );

            return response(res, 400, {
                success: false,
                message:
                    `Insufficient wallet balance. Your balance is ₦${money(currentBalance)}, but this product costs ₦${money(price)}.`
            });
        }


        /* =====================================================
           DEDUCT WALLET
        ===================================================== */

        console.log("CHARGING WALLET...");

        const walletTransaction =
            await walletRef.transaction(
                (balanceValue) => {

                    if (
                        balanceValue === null ||
                        balanceValue === undefined
                    ) {
                        return;
                    }

                    const balance =
                        Number(balanceValue);

                    if (!Number.isFinite(balance)) {
                        return;
                    }

                    if (balance < price) {
                        return;
                    }

                    return balance - price;
                }
            );


        console.log(
            "WALLET COMMITTED:",
            walletTransaction.committed
        );


        /* =====================================================
           WALLET FAILED
        ===================================================== */

        if (!walletTransaction.committed) {

            const latestWallet =
                await walletRef.once("value");

            const latestBalance =
                Number(latestWallet.val());

            await restoreInventory(
                selectedItemRef,
                uid
            );

            if (
                Number.isFinite(latestBalance) &&
                latestBalance < price
            ) {

                return response(res, 400, {
                    success: false,
                    message:
                        `Insufficient wallet balance. Your balance is ₦${money(latestBalance)}, but this product costs ₦${money(price)}.`
                });
            }

            return response(res, 500, {
                success: false,
                message:
                    "Your wallet could not be charged. Please try again."
            });
        }


        const newBalance =
            Number(
                walletTransaction.snapshot.val()
            );


        console.log(
            "NEW WALLET BALANCE:",
            newBalance
        );


        /* =====================================================
           DELIVERY
        ===================================================== */

        const deliveryDetails =
            reservedInventory.details !== undefined
                ? String(reservedInventory.details)
                : "";


        /* =====================================================
           CREATE ORDER
        ===================================================== */

        const orderRef =
            db.ref("orders").push();

        const orderId =
            orderRef.key;

        const order = {

            uid,

            email,

            productId,

            productName:
                product.name || "Unnamed Product",

            price,

            category:
                product.category || "Product",

            image:
                product.image || "",

            description:
                product.description || "",

            status:
                "completed",

            deliveryStatus:
                "delivered",

            deliveryDetails,

            inventoryId:
                reservedInventoryId,

            createdAt:
                Date.now()
        };


        try {

            await orderRef.set(order);

            console.log(
                "ORDER CREATED:",
                orderId
            );

        } catch (orderError) {

            console.error(
                "ORDER CREATION ERROR:",
                orderError
            );


            /* =================================================
               REFUND WALLET
            ================================================= */

            await walletRef.transaction(
                (balanceValue) => {

                    if (
                        balanceValue === null ||
                        balanceValue === undefined
                    ) {
                        return;
                    }

                    const balance =
                        Number(balanceValue);

                    if (!Number.isFinite(balance)) {
                        return;
                    }

                    return balance + price;
                }
            );


            /* =================================================
               RESTORE INVENTORY
            ================================================= */

            await restoreInventory(
                selectedItemRef,
                uid
            );


            return response(res, 500, {
                success: false,
                message:
                    "Purchase could not be completed. Your wallet has been refunded."
            });
        }


        /* =====================================================
           MARK INVENTORY SOLD
        ===================================================== */

        await selectedItemRef.update({

            status: "sold",

            soldTo: uid,

            soldOrderId: orderId,

            soldAt: Date.now(),

            processingBy: null,

            processingAt: null
        });


        console.log(
            "INVENTORY SOLD:",
            reservedInventoryId
        );


        /* =====================================================
           SUCCESS
        ===================================================== */

        console.log(
            "PURCHASE COMPLETED:",
            orderId
        );


        return response(res, 200, {

            success: true,

            message:
                "Purchase completed successfully.",

            orderId,

            balance:
                newBalance,

            deliveryDetails

        });


    } catch (error) {

        console.error(
            "PURCHASE API ERROR:",
            error
        );


        /* =====================================================
           RESTORE INVENTORY IF SOMETHING FAILED
        ===================================================== */

        if (
            reservedInventoryId &&
            uid
        ) {

            try {

                const restoreRef =
                    db.ref(
                        "inventory/" +
                        req.body.productId +
                        "/" +
                        reservedInventoryId
                    );

                await restoreInventory(
                    restoreRef,
                    uid
                );

            } catch (restoreError) {

                console.error(
                    "INVENTORY RESTORE ERROR:",
                    restoreError
                );
            }
        }


        return response(res, 500, {
            success: false,
            message:
                "Unable to complete your purchase right now. Please try again."
        });
    }
};


/* =========================================================
   RESTORE INVENTORY
========================================================= */

async function restoreInventory(
    itemRef,
    uid
) {

    try {

        const snapshot =
            await itemRef.once("value");

        if (!snapshot.exists()) {
            return;
        }

        const item =
            snapshot.val();

        if (
            item &&
            item.status === "processing" &&
            item.processingBy === uid
        ) {

            await itemRef.update({

                status: "available",

                processingBy: null,

                processingAt: null
            });

            console.log(
                "INVENTORY RESTORED"
            );
        }

    } catch (error) {

        console.error(
            "RESTORE ERROR:",
            error
        );
    }
}
