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
   RESPONSE HELPER
========================================= */

function sendJson(res, status, data) {

    return res
        .status(status)
        .json(data);

}


/* =========================================
   MONEY FORMAT
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
   RESTORE INVENTORY ITEM
========================================= */

async function restoreInventoryItem(
    itemRef,
    uid
) {

    try {

        await itemRef.transaction(
            (currentItem) => {

                if (!currentItem) {
                    return;
                }

                if (
                    currentItem.status === "processing" &&
                    currentItem.processingBy === uid
                ) {

                    const restored = {
                        ...currentItem
                    };

                    restored.status = "available";

                    delete restored.processingBy;
                    delete restored.processingAt;

                    return restored;

                }

                return;

            }
        );

    }
    catch (error) {

        console.error(
            "Inventory restore failed:",
            error
        );

    }

}


/* =========================================
   PURCHASE API
========================================= */

module.exports = async function handler(
    req,
    res
) {

    /* =====================================
       METHOD
    ===================================== */

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


    /* =====================================
       CHECK ENVIRONMENT
    ===================================== */

    if (
        !process.env.FIREBASE_PROJECT_ID ||
        !process.env.FIREBASE_CLIENT_EMAIL ||
        !process.env.FIREBASE_PRIVATE_KEY
    ) {

        console.error(
            "Firebase environment variables are missing."
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
           AUTHORIZATION
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
            "================================="
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
            "================================="
        );


        /* =================================
           LOAD PRODUCT
        ================================= */

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


        /* =================================
           PRICE
        ================================= */

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
                    price:
                        product.price
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
            "PRODUCT:",
            product.name
        );

        console.log(
            "PRICE:",
            price
        );


        /* =================================
           INVENTORY PATH
        ================================= */

        const inventoryRef =
            db.ref(
                "inventory/" + productId
            );


        const inventorySnapshot =
            await inventoryRef.once("value");


        if (
            !inventorySnapshot.exists()
        ) {

            console.log(
                "NO INVENTORY:",
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


        const inventory =
            inventorySnapshot.val();


        console.log(
            "Inventory loaded for product:",
            productId
        );


        console.log(
            "Inventory item count:",
            Object.keys(
                inventory || {}
            ).length
        );


        /* =================================
           RESERVE ONE AVAILABLE ITEM
           
           We use the parent inventory
           transaction so only one request
           can successfully reserve an item.
        ================================= */

        let reservedInventoryId =
            null;

        let reservedInventory =
            null;


        const inventoryTransaction =
            await inventoryRef.transaction(
                (currentInventory) => {

                    if (
                        !currentInventory ||
                        typeof currentInventory !==
                            "object"
                    ) {

                        return;

                    }


                    const updatedInventory = {
                        ...currentInventory
                    };


                    for (
                        const [
                            inventoryId,
                            inventoryItem
                        ]
                        of Object.entries(
                            currentInventory
                        )
                    ) {

                        if (
                            !inventoryItem
                        ) {

                            continue;

                        }


                        if (
                            inventoryItem.status !==
                            "available"
                        ) {

                            continue;

                        }


                        reservedInventoryId =
                            inventoryId;


                        reservedInventory = {

                            ...inventoryItem

                        };


                        updatedInventory[
                            inventoryId
                        ] = {

                            ...inventoryItem,

                            status:
                                "processing",

                            processingBy:
                                uid,

                            processingAt:
                                Date.now()

                        };


                        return updatedInventory;

                    }


                    return;

                }
            );


        /* =================================
           RESERVATION FAILED
        ================================= */

        if (
            !inventoryTransaction.committed ||
            !reservedInventoryId ||
            !reservedInventory
        ) {

            console.log(
                "NO AVAILABLE INVENTORY:",
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


        console.log(
            "INVENTORY RESERVED:",
            reservedInventoryId
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


        const walletSnapshot =
            await walletRef.once("value");


        const currentBalance =
            Number(
                walletSnapshot.val()
            ) || 0;


        console.log(
            "CURRENT WALLET:",
            currentBalance
        );


        if (
            currentBalance < price
        ) {

            console.log(
                "INSUFFICIENT BALANCE"
            );


            await restoreInventoryItem(
                reservedItemRef,
                uid
            );


            return sendJson(
                res,
                400,
                {
                    success: false,
                    message:
                        `Insufficient wallet balance. Your balance is ₦${formatMoney(currentBalance)}, but this product costs ₦${formatMoney(price)}.`
                }
            );

        }


        /* =================================
           DEDUCT WALLET
           
           Transaction protects against
           simultaneous purchases.
        ================================= */

        const walletTransaction =
            await walletRef.transaction(
                (balanceValue) => {

                    const balance =
                        Number(
                            balanceValue
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


        if (
            !walletTransaction.committed
        ) {

            console.log(
                "WALLET TRANSACTION FAILED"
            );


            await restoreInventoryItem(
                reservedItemRef,
                uid
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
            "WALLET DEDUCTED:",
            price
        );

        console.log(
            "NEW BALANCE:",
            newBalance
        );


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
                "ORDER CREATION FAILED:",
                orderError
            );


            /* Refund wallet */

            await walletRef.transaction(
                (balanceValue) => {

                    const balance =
                        Number(
                            balanceValue
                        ) || 0;


                    return (
                        balance + price
                    );

                }
            );


            /* Restore inventory */

            await restoreInventoryItem(
                reservedItemRef,
                uid
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


        /* =================================
           MARK INVENTORY SOLD
        ================================= */

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


                    return {

                        ...currentItem,

                        status:
                            "sold",

                        soldTo:
                            uid,

                        soldOrderId:
                            orderId,

                        soldAt:
                            Date.now()

                    };

                }
            );


        if (
            !soldTransaction.committed
        ) {

            console.error(
                "WARNING: INVENTORY COULD NOT BE MARKED SOLD",
                {
                    productId,
                    inventoryId:
                        reservedInventoryId,
                    orderId,
                    uid
                }
            );


            /*
             * The order and wallet transaction
             * already succeeded.
             *
             * Do not charge again.
             * Do not create another order.
             *
             * The inventory item remains
             * processing and can be recovered.
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
            "================================="
        );

        console.log(
            "PURCHASE COMPLETED"
        );

        console.log(
            "PRODUCT:",
            product.name
        );

        console.log(
            "INVENTORY:",
            reservedInventoryId
        );

        console.log(
            "ORDER:",
            orderId
        );

        console.log(
            "AMOUNT:",
            price
        );

        console.log(
            "NEW BALANCE:",
            newBalance
        );

        console.log(
            "================================="
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
            "================================="
        );

        console.error(
            "PURCHASE API ERROR"
        );

        console.error(
            error
        );

        console.error(
            "================================="
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
