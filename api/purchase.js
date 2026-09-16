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
   FIREBASE ADMIN INITIALIZATION
========================================================= */

if (!getApps().length) {
    const privateKey =
        process.env.FIREBASE_PRIVATE_KEY
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

const adminAuth = getAuth();
const db = getDatabase();


/* =========================================================
   HELPERS
========================================================= */

function sendJson(res, status, data) {
    return res.status(status).json(data);
}

function formatMoney(amount) {
    return Number(amount).toLocaleString("en-NG", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function isAvailable(item) {
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
   PURCHASE
========================================================= */

module.exports = async function handler(req, res) {

    if (req.method !== "POST") {
        return sendJson(res, 405, {
            success: false,
            message: "Method not allowed."
        });
    }

    try {

        /* =====================================================
           AUTH
        ===================================================== */

        const authorization =
            req.headers.authorization || "";

        if (!authorization.startsWith("Bearer ")) {
            return sendJson(res, 401, {
                success: false,
                message: "You must be logged in to make a purchase."
            });
        }

        const idToken =
            authorization.substring(7).trim();

        if (!idToken) {
            return sendJson(res, 401, {
                success: false,
                message: "Authentication token is missing."
            });
        }

        const decodedToken =
            await adminAuth.verifyIdToken(idToken);

        const uid = decodedToken.uid;
        const email = decodedToken.email || "";


        /* =====================================================
           PRODUCT ID
        ===================================================== */

        const productId =
            req.body &&
            req.body.productId
                ? String(req.body.productId).trim()
                : "";

        if (!productId) {
            return sendJson(res, 400, {
                success: false,
                message: "Product ID is required."
            });
        }


        /* =====================================================
           GET PRODUCT
        ===================================================== */

        const productRef =
            db.ref("products/" + productId);

        const productSnapshot =
            await productRef.once("value");

        if (!productSnapshot.exists()) {
            return sendJson(res, 404, {
                success: false,
                message: "Product not found."
            });
        }

        const product =
            productSnapshot.val();

        if (product.active === false) {
            return sendJson(res, 400, {
                success: false,
                message: "This product is currently unavailable."
            });
        }

        const price =
            Number(product.price);

        if (!Number.isFinite(price) || price <= 0) {
            return sendJson(res, 400, {
                success: false,
                message: "This product has an invalid price."
            });
        }


        /* =====================================================
           GET INVENTORY
        ===================================================== */

        const inventoryRef =
            db.ref("inventory/" + productId);

        const inventorySnapshot =
            await inventoryRef.once("value");

        if (!inventorySnapshot.exists()) {
            return sendJson(res, 409, {
                success: false,
                message:
                    "This product is currently out of stock. Please try again."
            });
        }

        const inventory =
            inventorySnapshot.val();

        if (!inventory || typeof inventory !== "object") {
            return sendJson(res, 409, {
                success: false,
                message:
                    "This product is currently out of stock. Please try again."
            });
        }


        /* =====================================================
           FIND AND RESERVE INVENTORY
           
           IMPORTANT:
           We READ THE ITEM FIRST before starting the
           transaction. This prevents Firebase transaction
           callbacks receiving null and incorrectly aborting.
        ===================================================== */

        let reservedInventoryId = null;
        let reservedInventory = null;

        const entries =
            Object.entries(inventory);

        for (const [inventoryId] of entries) {

            const itemRef =
                inventoryRef.child(inventoryId);

            /*
             * First get the real current value from Firebase.
             */
            const itemSnapshot =
                await itemRef.once("value");

            if (!itemSnapshot.exists()) {
                continue;
            }

            const currentItem =
                itemSnapshot.val();

            if (!isAvailable(currentItem)) {
                continue;
            }


            /*
             * Now perform the transaction.
             */
            const transactionResult =
                await itemRef.transaction(
                    (item) => {

                        /*
                         * Firebase may initially provide null
                         * to a transaction callback.
                         *
                         * We abort safely in that case.
                         */
                        if (
                            item === null ||
                            item === undefined
                        ) {
                            return;
                        }

                        if (
                            typeof item !== "object"
                        ) {
                            return;
                        }

                        const status =
                            typeof item.status === "string"
                                ? item.status
                                    .trim()
                                    .toLowerCase()
                                : "";

                        if (
                            status !== "available" &&
                            status !== ""
                        ) {
                            return;
                        }

                        return {
                            ...item,

                            status: "processing",

                            processingBy: uid,

                            processingAt: Date.now()
                        };
                    }
                );


            if (transactionResult.committed) {

                reservedInventoryId =
                    inventoryId;

                reservedInventory =
                    transactionResult.snapshot.val();

                break;
            }
        }


        /* =====================================================
           NO INVENTORY RESERVED
        ===================================================== */

        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {

            return sendJson(res, 409, {
                success: false,
                message:
                    "This product is currently out of stock. Please try again."
            });
        }


        /* =====================================================
           WALLET
        ===================================================== */

        const walletRef =
            db.ref(
                "users/" +
                uid +
                "/walletBalance"
            );


        /*
         * READ WALLET FIRST.
         *
         * This is important for the same Firebase
         * transaction/null issue.
         */
        const walletSnapshot =
            await walletRef.once("value");


        if (!walletSnapshot.exists()) {

            /*
             * Restore inventory.
             */
            await reservedInventoryRefRestore(
                inventoryRef,
                reservedInventoryId,
                uid
            );

            return sendJson(res, 400, {
                success: false,
                message:
                    "Your wallet balance could not be found."
            });
        }


        const initialBalance =
            Number(walletSnapshot.val());


        if (!Number.isFinite(initialBalance)) {

            await reservedInventoryRefRestore(
                inventoryRef,
                reservedInventoryId,
                uid
            );

            return sendJson(res, 400, {
                success: false,
                message:
                    "Your wallet balance is invalid."
            });
        }


        if (initialBalance < price) {

            await reservedInventoryRefRestore(
                inventoryRef,
                reservedInventoryId,
                uid
            );

            return sendJson(res, 400, {
                success: false,
                message:
                    `Insufficient wallet balance. Your balance is ₦${formatMoney(initialBalance)}, but this product costs ₦${formatMoney(price)}.`
            });
        }


        /* =====================================================
           CHARGE WALLET
        ===================================================== */

        const walletTransaction =
            await walletRef.transaction(
                (currentBalance) => {

                    /*
                     * Do NOT convert null into zero.
                     */
                    if (
                        currentBalance === null ||
                        currentBalance === undefined
                    ) {
                        return;
                    }

                    const balance =
                        Number(currentBalance);

                    if (
                        !Number.isFinite(balance)
                    ) {
                        return;
                    }

                    if (
                        balance < price
                    ) {
                        return;
                    }

                    return balance - price;
                }
            );


        /* =====================================================
           WALLET TRANSACTION FAILED
        ===================================================== */

        if (!walletTransaction.committed) {

            /*
             * Check the actual latest wallet balance.
             */
            const latestWalletSnapshot =
                await walletRef.once("value");

            const latestBalance =
                Number(
                    latestWalletSnapshot.val()
                );


            /*
             * Restore inventory.
             */
            await reservedInventoryRefRestore(
                inventoryRef,
                reservedInventoryId,
                uid
            );


            if (
                Number.isFinite(latestBalance) &&
                latestBalance < price
            ) {

                return sendJson(res, 400, {
                    success: false,
                    message:
                        `Insufficient wallet balance. Your balance is ₦${formatMoney(latestBalance)}, but this product costs ₦${formatMoney(price)}.`
                });
            }


            return sendJson(res, 500, {
                success: false,
                message:
                    "The wallet transaction could not be completed. Please try again."
            });
        }


        const newBalance =
            Number(
                walletTransaction.snapshot.val()
            );


        /* =====================================================
           DELIVERY DETAILS
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

        } catch (orderError) {

            console.error(
                "ORDER CREATION FAILED:",
                orderError
            );


            /*
             * Refund wallet.
             */
            await walletRef.transaction(
                (currentBalance) => {

                    if (
                        currentBalance === null ||
                        currentBalance === undefined
                    ) {
                        return;
                    }

                    const balance =
                        Number(currentBalance);

                    if (
                        !Number.isFinite(balance)
                    ) {
                        return;
                    }

                    return balance + price;
                }
            );


            /*
             * Restore inventory.
             */
            await reservedInventoryRefRestore(
                inventoryRef,
                reservedInventoryId,
                uid
            );


            return sendJson(res, 500, {
                success: false,
                message:
                    "Your purchase could not be completed. Your wallet has not been charged."
            });
        }


        /* =====================================================
           MARK INVENTORY SOLD
        ===================================================== */

        const reservedItemRef =
            inventoryRef.child(
                reservedInventoryId
            );

        const soldTransaction =
            await reservedItemRef.transaction(
                (item) => {

                    if (
                        item === null ||
                        item === undefined
                    ) {
                        return;
                    }

                    if (
                        typeof item !== "object"
                    ) {
                        return;
                    }

                    if (
                        item.status !== "processing"
                    ) {
                        return;
                    }

                    if (
                        item.processingBy !== uid
                    ) {
                        return;
                    }

                    return {
                        ...item,

                        status: "sold",

                        soldTo: uid,

                        soldOrderId: orderId,

                        soldAt: Date.now()
                    };
                }
            );


        if (!soldTransaction.committed) {

            console.error(
                "WARNING: Order created but inventory was not marked sold.",
                {
                    productId,
                    inventoryId: reservedInventoryId,
                    orderId,
                    uid
                }
            );
        }


        /* =====================================================
           SUCCESS
        ===================================================== */

        return sendJson(res, 200, {

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

        return sendJson(res, 500, {
            success: false,
            message:
                "Unable to complete your purchase right now. Please try again."
        });
    }
};


/* =========================================================
   RESTORE INVENTORY
========================================================= */

async function reservedInventoryRefRestore(
    inventoryRef,
    inventoryId,
    uid
) {

    const itemRef =
        inventoryRef.child(inventoryId);

    await itemRef.transaction(
        (item) => {

            if (
                item === null ||
                item === undefined
            ) {
                return;
            }

            if (
                typeof item !== "object"
            ) {
                return;
            }

            if (
                item.status === "processing" &&
                item.processingBy === uid
            ) {

                const restored = {
                    ...item,

                    status: "available"
                };

                delete restored.processingBy;
                delete restored.processingAt;

                return restored;
            }

            return;
        }
    );
}
