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


/* =========================================
   FIREBASE ADMIN INITIALIZATION
========================================= */

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


/* =========================================
   JSON RESPONSE
========================================= */

function sendJson(res, status, data) {

    return res
        .status(status)
        .json(data);

}


/* =========================================
   FORMAT MONEY
========================================= */

function formatMoney(amount) {

    return Number(amount).toLocaleString(
        "en-NG",
        {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }
    );

}


/* =========================================
   PURCHASE HANDLER
========================================= */

module.exports = async function handler(req, res) {

    /* -------------------------------------
       METHOD
    ------------------------------------- */

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


    /* -------------------------------------
       ENVIRONMENT VARIABLES
    ------------------------------------- */

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

        /* =================================
           AUTHENTICATION
        ================================= */

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


        /* =================================
           PRODUCT ID
        ================================= */

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
            "Purchase started:",
            {
                uid,
                email,
                productId
            }
        );


        /* =================================
           GET PRODUCT
        ================================= */

        const productRef =
            db.ref(
                "products/" + productId
            );


        const productSnapshot =
            await productRef.once("value");


        if (!productSnapshot.exists()) {

            console.error(
                "Product not found:",
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


        if (product.active === false) {

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


        const price =
            Number(product.price);


        if (
            !Number.isFinite(price) ||
            price <= 0
        ) {

            console.error(
                "Invalid product price:",
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


        /* =================================
           INVENTORY
        ================================= */

        const inventoryRef =
            db.ref(
                "inventory/" + productId
            );


        const inventorySnapshot =
            await inventoryRef.once("value");


        const inventory =
            inventorySnapshot.val();


        if (
            !inventory ||
            typeof inventory !== "object"
        ) {

            console.log(
                "No inventory exists:",
                productId
            );

            return sendJson(
                res,
                409,
                {
                    success: false,
                    message:
                        "This product is currently out of stock."
                }
            );

        }


        /* =================================
           FIND AND RESERVE ONE ITEM
        ================================= */

        let reservedInventoryId = null;
        let reservedInventory = null;


        const inventoryEntries =
            Object.entries(inventory);


        console.log(
            "Inventory items found:",
            inventoryEntries.length
        );


        for (
            const [
                inventoryId,
                inventoryItem
            ]
            of inventoryEntries
        ) {

            if (!inventoryItem) {
                continue;
            }


            console.log(
                "Checking inventory item:",
                {
                    inventoryId,
                    status:
                        inventoryItem.status
                }
            );


            if (
                inventoryItem.status !==
                "available"
            ) {

                continue;

            }


            const itemRef =
                inventoryRef.child(
                    inventoryId
                );


            const transactionResult =
                await itemRef.transaction(
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


            console.log(
                "Inventory transaction:",
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


        /* =================================
           NO ITEM RESERVED
        ================================= */

        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {

            console.error(
                "Could not reserve inventory.",
                {
                    productId,
                    uid
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
            "Inventory reserved:",
            {
                productId,
                inventoryId:
                    reservedInventoryId,
                uid
            }
        );


        const reservedItemRef =
            inventoryRef.child(
                reservedInventoryId
            );


        /* =================================
           WALLET
        ================================= */

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


        /* =================================
           INSUFFICIENT BALANCE
        ================================= */

        if (
            !walletTransaction.committed
        ) {

            console.log(
                "Insufficient balance:",
                {
                    uid,
                    price
                }
            );


            /* Restore inventory */

            await reservedItemRef.transaction(
                (currentItem) => {

                    if (!currentItem) {

                        return;

                    }


                    if (
                        currentItem.status ===
                        "processing" &&
                        currentItem.processingBy ===
                        uid
                    ) {

                        const restored = {
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


        /* =================================
           DELIVERY DETAILS
        ================================= */

        const deliveryDetails =
            reservedInventory.details !==
            undefined
                ? String(
                    reservedInventory.details
                )
                : "";


        /* =================================
           CREATE ORDER
        ================================= */

        const orderRef =
            db.ref("orders").push();


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


        try {

            await orderRef.set(
                order
            );

        }

        catch(orderError) {

            console.error(
                "Order creation failed:",
                orderError
            );


            /* Refund wallet */

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


            /* Restore inventory */

            await reservedItemRef.transaction(
                (currentItem) => {

                    if (!currentItem) {

                        return;

                    }


                    if (
                        currentItem.status ===
                        "processing" &&
                        currentItem.processingBy ===
                        uid
                    ) {

                        const restored = {
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


        /* =================================
           MARK INVENTORY SOLD
        ================================= */

        const soldTransaction =
            await reservedItemRef.transaction(
                (currentItem) => {

                    if (!currentItem) {

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


                    const soldItem = {
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


        if (
            !soldTransaction.committed
        ) {

            console.error(
                "Could not mark inventory sold:",
                {
                    productId,
                    inventoryId:
                        reservedInventoryId,
                    orderId,
                    uid
                }
            );

            /*
             * The order already exists and the wallet
             * was already charged, so do NOT create
             * another order or charge again.
             *
             * The item remains processing and can
             * be recovered by admin.
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


        /* =================================
           SUCCESS
        ================================= */

        console.log(
            "Purchase completed:",
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

    catch(error) {

        console.error(
            "Purchase API error:",
            error
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
