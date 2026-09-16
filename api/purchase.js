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
   RESTORE INVENTORY ITEM
========================================= */

async function restoreInventoryItem(
    itemRef,
    uid
) {

    try {

        await itemRef.transaction(
            (currentItem) => {

                if (
                    !currentItem ||
                    typeof currentItem !== "object"
                ) {

                    return;

                }


                if (
                    currentItem.status === "processing" &&
                    currentItem.processingBy === uid
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

    }

    catch (error) {

        console.error(
            "Could not restore inventory item:",
            error
        );

    }

}


/* =========================================
   PURCHASE HANDLER
========================================= */

module.exports = async function handler(req, res) {

    /* =====================================
       METHOD
    ===================================== */

    if (req.method !== "POST") {

        return sendJson(
            res,
            405,
            {
                success: false,
                message:
                    "Method not allowed."
            }
        );

    }


    /* =====================================
       ENVIRONMENT VARIABLES
    ===================================== */

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
            !authorization.startsWith(
                "Bearer "
            )
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
           GET PRODUCT
        ================================= */

        const productRef =
            db.ref(
                "products/" + productId
            );


        const productSnapshot =
            await productRef.once(
                "value"
            );


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
            {
                productId,
                name:
                    product.name,
                price:
                    product.price,
                active:
                    product.active
            }
        );


        /* =================================
           PRODUCT ACTIVE
        ================================= */

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
           PRODUCT PRICE
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


        /* =================================
           INVENTORY PATH
        ================================= */

        const inventoryPath =
            "inventory/" + productId;


        console.log(
            "INVENTORY PATH:",
            inventoryPath
        );


        const inventoryRef =
            db.ref(
                inventoryPath
            );


        const inventorySnapshot =
            await inventoryRef.once(
                "value"
            );


        const inventory =
            inventorySnapshot.val();


        /* =================================
           INVENTORY EXISTS
        ================================= */

        if (
            !inventory ||
            typeof inventory !== "object"
        ) {

            console.error(
                "NO INVENTORY FOUND:",
                {
                    productId,
                    inventoryPath
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


        const inventoryEntries =
            Object.entries(
                inventory
            );


        console.log(
            "INVENTORY ITEM COUNT:",
            inventoryEntries.length
        );


        /* =================================
           RESERVE ONE ITEM
        ================================= */

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


            const normalizedStatus =
                typeof rawStatus === "string"
                    ? rawStatus
                        .trim()
                        .toLowerCase()
                    : "";


            const hasDeliveryDetails =
                inventoryItem.details !== undefined &&
                inventoryItem.details !== null &&
                String(
                    inventoryItem.details
                ).trim() !== "";


            /*
             * Accept normal available items.
             *
             * Also accept older inventory records
             * where status is missing but delivery
             * details exist.
             */

            const isAvailable =
                normalizedStatus === "available" ||
                (
                    !normalizedStatus &&
                    hasDeliveryDetails
                );


            console.log(
                "CHECKING INVENTORY ITEM:",
                {
                    inventoryId,
                    status:
                        rawStatus,
                    normalizedStatus,
                    hasDeliveryDetails,
                    isAvailable
                }
            );


            if (!isAvailable) {

                continue;

            }


            const itemRef =
                inventoryRef.child(
                    inventoryId
                );


            /* =============================
               TRANSACTION
            ============================= */

            const transactionResult =
                await itemRef.transaction(
                    (currentItem) => {

                        if (
                            !currentItem ||
                            typeof currentItem !== "object"
                        ) {

                            return;

                        }


                        const currentStatus =
                            typeof currentItem.status === "string"
                                ? currentItem.status
                                    .trim()
                                    .toLowerCase()
                                : "";


                        const currentHasDetails =
                            currentItem.details !== undefined &&
                            currentItem.details !== null &&
                            String(
                                currentItem.details
                            ).trim() !== "";


                        const currentIsAvailable =
                            currentStatus === "available" ||
                            (
                                !currentStatus &&
                                currentHasDetails
                            );


                        if (!currentIsAvailable) {

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


        /* =================================
           NO ITEM AVAILABLE
        ================================= */

        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {

            console.error(
                "NO AVAILABLE INVENTORY:",
                {
                    productId,
                    productName:
                        product.name
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
                "INSUFFICIENT BALANCE:",
                {
                    uid,
                    price
                }
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
            "WALLET CHARGED:",
            {
                uid,
                price,
                newBalance
            }
        );


        /* =================================
           DELIVERY DETAILS
        ================================= */

        const deliveryDetails =
            reservedInventory.details !== undefined
                ? String(
                    reservedInventory.details
                )
                : "";


        /* =================================
           CREATE ORDER
        ================================= */

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


        /* =================================
           SAVE ORDER
        ================================= */

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


            /* =============================
               REFUND WALLET
            ============================= */

            try {

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

            }

            catch(refundError) {

                console.error(
                    "REFUND FAILED:",
                    refundError
                );

            }


            /* =============================
               RESTORE INVENTORY
            ============================= */

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
            {
                orderId,
                productId,
                inventoryId:
                    reservedInventoryId
            }
        );


        /* =================================
           MARK ITEM SOLD
        ================================= */

        const soldTransaction =
            await reservedItemRef.transaction(
                (currentItem) => {

                    if (
                        !currentItem ||
                        typeof currentItem !== "object"
                    ) {

                        return;

                    }


                    const currentStatus =
                        typeof currentItem.status === "string"
                            ? currentItem.status
                                .trim()
                                .toLowerCase()
                            : "";


                    if (
                        currentStatus !==
                            "processing" ||
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


        /* =================================
           SOLD FAILED
        ================================= */

        if (
            !soldTransaction.committed
        ) {

            /*
             * The wallet has already been charged
             * and the order already exists.
             *
             * Do not charge again.
             * Do not create another order.
             *
             * The item remains processing and can
             * be recovered from the admin side.
             */

            console.error(
                "COULD NOT MARK INVENTORY SOLD:",
                {
                    productId,
                    inventoryId:
                        reservedInventoryId,
                    orderId,
                    uid
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
            "================================="
        );


        return sendJson(
            res,
            200,
            {
                success:
                    true,

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
            "PURCHASE API ERROR:"
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
                success:
                    false,

                message:
                    "Unable to complete your purchase right now. Please try again."
            }
        );

    }

};
