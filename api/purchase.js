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

            projectId:
                process.env.FIREBASE_PROJECT_ID,

            clientEmail:
                process.env.FIREBASE_CLIENT_EMAIL,

            privateKey:
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

    return res
        .status(status)
        .json(data);

}


function formatMoney(amount) {

    return Number(amount).toLocaleString(
        "en-NG",
        {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }
    );

}


/*
 * Inventory status checker.
 *
 * Accepts:
 * available
 * Available
 * AVAILABLE
 *
 * Also supports old inventory records where the
 * status field was not saved.
 */
function isAvailableInventoryItem(item) {

    if (!item || typeof item !== "object") {
        return false;
    }


    const status =
        typeof item.status === "string"
            ? item.status.trim().toLowerCase()
            : "";


    if (status === "available") {
        return true;
    }


    /*
     * Legacy inventory support.
     *
     * If your older admin system created an item without
     * a status field, we treat it as available.
     */
    if (!status) {
        return true;
    }


    return false;

}


/* =========================================================
   PURCHASE HANDLER
========================================================= */

module.exports = async function handler(req, res) {


    /* =====================================================
       ONLY POST
    ===================================================== */

    if (req.method !== "POST") {

        return sendJson(
            res,
            405,
            {
                success: false,
                message: "Method not allowed."
            }
        );

    }


    /* =====================================================
       CHECK FIREBASE ENVIRONMENT VARIABLES
    ===================================================== */

    if (
        !process.env.FIREBASE_PROJECT_ID ||
        !process.env.FIREBASE_CLIENT_EMAIL ||
        !process.env.FIREBASE_PRIVATE_KEY
    ) {

        console.error(
            "Missing Firebase environment variables."
        );

        return sendJson(
            res,
            500,
            {
                success: false,
                message:
                    "Purchase server is not configured correctly."
            }
        );

    }


    try {


        /* =================================================
           AUTHENTICATION
        ================================================= */

        const authorization =
            req.headers.authorization || "";


        if (
            !authorization.startsWith("Bearer ")
        ) {

            return sendJson(
                res,
                401,
                {
                    success: false,
                    message:
                        "You must be logged in to make a purchase."
                }
            );

        }


        const idToken =
            authorization
                .substring(7)
                .trim();


        if (!idToken) {

            return sendJson(
                res,
                401,
                {
                    success: false,
                    message:
                        "Authentication token is missing."
                }
            );

        }


        const decodedToken =
            await adminAuth.verifyIdToken(
                idToken
            );


        const uid =
            decodedToken.uid;


        const email =
            decodedToken.email || "";


        /* =================================================
           PRODUCT ID
        ================================================= */

        const productId =
            req.body &&
            req.body.productId
                ? String(
                    req.body.productId
                ).trim()
                : "";


        if (!productId) {

            return sendJson(
                res,
                400,
                {
                    success: false,
                    message:
                        "Product ID is required."
                }
            );

        }


        console.log(
            "========================================"
        );

        console.log(
            "PURCHASE STARTED"
        );

        console.log(
            "UID:",
            uid
        );

        console.log(
            "EMAIL:",
            email
        );

        console.log(
            "PRODUCT ID:",
            productId
        );

        console.log(
            "========================================"
        );


        /* =================================================
           GET PRODUCT
        ================================================= */

        const productRef =
            db.ref(
                "products/" + productId
            );


        const productSnapshot =
            await productRef.once("value");


        if (!productSnapshot.exists()) {

            console.error(
                "PRODUCT NOT FOUND:",
                productId
            );

            return sendJson(
                res,
                404,
                {
                    success: false,
                    message:
                        "Product not found."
                }
            );

        }


        const product =
            productSnapshot.val();


        console.log(
            "PRODUCT FOUND:",
            product.name
        );


        /* =================================================
           PRODUCT ACTIVE CHECK
        ================================================= */

        if (
            product.active === false
        ) {

            return sendJson(
                res,
                400,
                {
                    success: false,
                    message:
                        "This product is currently unavailable."
                }
            );

        }


        /* =================================================
           PRODUCT PRICE
        ================================================= */

        const price =
            Number(
                product.price
            );


        if (
            !Number.isFinite(price) ||
            price <= 0
        ) {

            console.error(
                "INVALID PRODUCT PRICE:",
                {
                    productId,
                    price: product.price
                }
            );

            return sendJson(
                res,
                400,
                {
                    success: false,
                    message:
                        "This product has an invalid price."
                }
            );

        }


        console.log(
            "PRODUCT PRICE:",
            price
        );


        /* =================================================
           INVENTORY PATH
        ================================================= */

        const inventoryRef =
            db.ref(
                "inventory/" + productId
            );


        const inventorySnapshot =
            await inventoryRef.once(
                "value"
            );


        const inventory =
            inventorySnapshot.val();


        /* =================================================
           INVENTORY EXISTS CHECK
        ================================================= */

        if (
            !inventory ||
            typeof inventory !== "object"
        ) {

            console.error(
                "NO INVENTORY FOUND:",
                productId
            );

            return sendJson(
                res,
                409,
                {
                    success: false,
                    message:
                        "This product is currently out of stock. Please try again."
                }
            );

        }


        const inventoryEntries =
            Object.entries(
                inventory
            );


        console.log(
            "TOTAL INVENTORY ITEMS:",
            inventoryEntries.length
        );


        /* =================================================
           FIND AVAILABLE ITEM
        ================================================= */

        let reservedInventoryId =
            null;

        let reservedInventory =
            null;


        for (
            const [
                inventoryId,
                inventoryItem
            ]
            of inventoryEntries
        ) {


            if (
                !inventoryItem ||
                typeof inventoryItem !== "object"
            ) {

                continue;

            }


            const rawStatus =
                inventoryItem.status;


            console.log(
                "CHECKING INVENTORY:",
                {
                    inventoryId,
                    status:
                        rawStatus
                }
            );


            if (
                !isAvailableInventoryItem(
                    inventoryItem
                )
            ) {

                continue;

            }


            const itemRef =
                inventoryRef.child(
                    inventoryId
                );


            /* =================================================
               RESERVE ITEM
            ================================================= */

            const transactionResult =
                await itemRef.transaction(
                    (currentItem) => {


                        if (
                            !currentItem ||
                            typeof currentItem !== "object"
                        ) {

                            return;

                        }


                        /*
                         * Re-check availability inside
                         * the transaction.
                         */

                        const currentStatus =
                            typeof currentItem.status === "string"
                                ? currentItem.status
                                    .trim()
                                    .toLowerCase()
                                : "";


                        /*
                         * Accept:
                         * available
                         * Available
                         * AVAILABLE
                         * missing status (legacy)
                         */

                        const canPurchase =
                            currentStatus === "available" ||
                            currentStatus === "";


                        if (!canPurchase) {

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


            console.log(
                "RESERVATION RESULT:",
                {
                    inventoryId,
                    committed:
                        transactionResult.committed
                }
            );


            if (
                transactionResult.committed
            ) {

                reservedInventoryId =
                    inventoryId;


                reservedInventory =
                    transactionResult
                        .snapshot
                        .val();


                break;

            }

        }


        /* =================================================
           NO AVAILABLE ITEM
        ================================================= */

        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {

            console.error(
                "NO AVAILABLE INVENTORY ITEM.",
                {
                    productId,
                    totalItems:
                        inventoryEntries.length
                }
            );


            return sendJson(
                res,
                409,
                {
                    success: false,
                    message:
                        "This product is currently out of stock. Please try again."
                }
            );

        }


        console.log(
            "INVENTORY RESERVED:",
            reservedInventoryId
        );


        const reservedItemRef =
            inventoryRef.child(
                reservedInventoryId
            );


        /* =================================================
           WALLET
        ================================================= */

        const walletRef =
            db.ref(
                "users/" +
                uid +
                "/walletBalance"
            );


        const walletTransaction =
            await walletRef.transaction(
                (currentBalance) => {


                    const balance =
                        Number(
                            currentBalance
                        ) || 0;


                    console.log(
                        "CURRENT WALLET:",
                        balance
                    );


                    if (
                        balance < price
                    ) {

                        return;

                    }


                    return (
                        balance - price
                    );

                }
            );


        /* =================================================
           INSUFFICIENT BALANCE
        ================================================= */

        if (
            !walletTransaction.committed
        ) {


            console.log(
                "INSUFFICIENT BALANCE."
            );


            /* ---------------------------------------------
               RESTORE INVENTORY
            --------------------------------------------- */

            await reservedItemRef.transaction(
                (currentItem) => {


                    if (
                        !currentItem
                    ) {

                        return;

                    }


                    if (
                        currentItem.status ===
                            "processing" &&
                        currentItem.processingBy ===
                            uid
                    ) {


                        const restored =
                            {
                                ...currentItem
                            };


                        restored.status =
                            "available";


                        delete restored.processingBy;
                        delete restored.processingAt;


                        return restored;

                    }


                    return;

                }
            );


            const latestWalletSnapshot =
                await walletRef.once(
                    "value"
                );


            const latestBalance =
                Number(
                    latestWalletSnapshot.val()
                ) || 0;


            return sendJson(
                res,
                400,
                {
                    success: false,
                    message:
                        `Insufficient wallet balance. Your balance is ₦${formatMoney(latestBalance)}, but this product costs ₦${formatMoney(price)}.`
                }
            );

        }


        const newBalance =
            Number(
                walletTransaction
                    .snapshot
                    .val()
            ) || 0;


        console.log(
            "WALLET CHARGED:",
            {
                price,
                newBalance
            }
        );


        /* =================================================
           DELIVERY DETAILS
        ================================================= */

        const deliveryDetails =
            reservedInventory.details !== undefined
                ? String(
                    reservedInventory.details
                )
                : "";


        console.log(
            "DELIVERY DETAILS FOUND:",
            deliveryDetails
                ? "YES"
                : "NO"
        );


        /* =================================================
           CREATE ORDER
        ================================================= */

        const orderRef =
            db.ref(
                "orders"
            ).push();


        const orderId =
            orderRef.key;


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
                reservedInventoryId,

            createdAt:
                Date.now()

        };


        /* =================================================
           SAVE ORDER
        ================================================= */

        try {

            await orderRef.set(
                order
            );

        }
        catch (orderError) {

            console.error(
                "ORDER CREATION FAILED:",
                orderError
            );


            /* ---------------------------------------------
               REFUND WALLET
            --------------------------------------------- */

            await walletRef.transaction(
                (currentBalance) => {

                    const balance =
                        Number(
                            currentBalance
                        ) || 0;


                    return (
                        balance + price
                    );

                }
            );


            /* ---------------------------------------------
               RESTORE INVENTORY
            --------------------------------------------- */

            await reservedItemRef.transaction(
                (currentItem) => {


                    if (
                        !currentItem
                    ) {

                        return;

                    }


                    if (
                        currentItem.status ===
                            "processing" &&
                        currentItem.processingBy ===
                            uid
                    ) {


                        const restored =
                            {
                                ...currentItem
                            };


                        restored.status =
                            "available";


                        delete restored.processingBy;
                        delete restored.processingAt;


                        return restored;

                    }


                    return;

                }
            );


            return sendJson(
                res,
                500,
                {
                    success: false,
                    message:
                        "Your purchase could not be completed. Your wallet has not been charged."
                }
            );

        }


        console.log(
            "ORDER CREATED:",
            orderId
        );


        /* =================================================
           MARK INVENTORY SOLD
        ================================================= */

        const soldTransaction =
            await reservedItemRef.transaction(
                (currentItem) => {


                    if (
                        !currentItem
                    ) {

                        return;

                    }


                    if (
                        currentItem.status !==
                        "processing"
                    ) {

                        return;

                    }


                    if (
                        currentItem.processingBy !==
                        uid
                    ) {

                        return;

                    }


                    const soldItem =
                        {
                            ...currentItem
                        };


                    soldItem.status =
                        "sold";


                    soldItem.soldTo =
                        uid;


                    soldItem.soldOrderId =
                        orderId;


                    soldItem.soldAt =
                        Date.now();


                    delete soldItem.processingBy;
                    delete soldItem.processingAt;


                    return soldItem;

                }
            );


        /* =================================================
           INVENTORY SOLD CHECK
        ================================================= */

        if (
            !soldTransaction.committed
        ) {

            console.error(
                "WARNING: ORDER CREATED BUT INVENTORY COULD NOT BE MARKED SOLD.",
                {
                    productId,
                    inventoryId:
                        reservedInventoryId,
                    orderId,
                    uid
                }
            );


            /*
             * Do not charge again.
             * Do not create another order.
             *
             * The order already exists and the customer
             * already received the delivery information.
             */

            return sendJson(
                res,
                200,
                {
                    success: true,

                    message:
                        "Purchase completed successfully.",

                    orderId:
                        orderId,

                    balance:
                        newBalance,

                    deliveryDetails:
                        deliveryDetails

                }
            );

        }


        /* =================================================
           SUCCESS
        ================================================= */

        console.log(
            "========================================"
        );

        console.log(
            "PURCHASE COMPLETED"
        );

        console.log(
            {
                uid,
                email,
                productId,
                inventoryId:
                    reservedInventoryId,
                orderId,
                price,
                newBalance
            }
        );

        console.log(
            "========================================"
        );


        return sendJson(
            res,
            200,
            {
                success: true,

                message:
                    "Purchase completed successfully.",

                orderId:
                    orderId,

                balance:
                    newBalance,

                deliveryDetails:
                    deliveryDetails

            }
        );

    }


    /* =====================================================
       GLOBAL ERROR
    ===================================================== */

    catch (error) {

        console.error(
            "========================================"
        );

        console.error(
            "PURCHASE API ERROR"
        );

        console.error(
            error
        );

        console.error(
            "========================================"
        );


        return sendJson(
            res,
            500,
            {
                success: false,
                message:
                    "Unable to complete your purchase right now. Please try again."
            }
        );

    }

};
