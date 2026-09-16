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
   FIREBASE ADMIN
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
   JSON
========================================= */

function sendJson(res, status, data) {

    return res
        .status(status)
        .json(data);

}


/* =========================================
   MONEY
========================================= */

function money(amount) {

    return Number(amount).toLocaleString(
        "en-NG",
        {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }
    );

}


/* =========================================
   PURCHASE
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
                message: "Method not allowed."
            }
        );

    }


    /* =====================================
       FIREBASE CONFIG
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
           AUTH
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
                ? String(req.body.productId).trim()
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
            "PRODUCT ID:",
            productId
        );

        console.log(
            "================================="
        );


        /* =================================
           PRODUCT
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


        console.log(
            "PRODUCT FOUND:",
            {
                productId,
                name: product.name,
                price: product.price,
                active: product.active
            }
        );


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


        const price =
            Number(product.price);


        if (
            !Number.isFinite(price) ||
            price <= 0
        ) {

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

        const inventoryPath =
            "inventory/" + productId;


        console.log(
            "CHECKING INVENTORY PATH:",
            inventoryPath
        );


        const inventoryRef =
            db.ref(inventoryPath);


        const inventorySnapshot =
            await inventoryRef.once("value");


        if (!inventorySnapshot.exists()) {

            console.error(
                "NO INVENTORY AT PATH:",
                inventoryPath
            );

            return sendJson(
                res,
                409,
                {
                    success: false,

                    message:
                        "No inventory is linked to this product.",

                    debug: {
                        productId: productId,
                        productName:
                            product.name || "",
                        inventoryPath:
                            inventoryPath
                    }

                }
            );

        }


        const inventory =
            inventorySnapshot.val();


        console.log(
            "INVENTORY FOUND:",
            inventory
        );


        /* =================================
           FIND AVAILABLE ITEM
        ================================= */

        let reservedInventoryId = null;

        let reservedInventory = null;


        for (
            const [
                inventoryId,
                inventoryItem
            ]
            of Object.entries(inventory)
        ) {

            if (!inventoryItem) {
                continue;
            }


            console.log(
                "INVENTORY ITEM:",
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
           OUT OF STOCK
        ================================= */

        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {

            console.error(
                "AVAILABLE INVENTORY NOT FOUND:",
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
                        "Inventory exists, but no item has status 'available'.",

                    debug: {
                        productId:
                            productId,

                        productName:
                            product.name || "",

                        inventoryPath:
                            inventoryPath,

                        statuses:
                            Object.fromEntries(
                                Object.entries(
                                    inventory
                                ).map(
                                    ([id, item]) => [
                                        id,
                                        item
                                            ? item.status
                                            : null
                                    ]
                                )
                            )
                    }

                }
            );

        }


        console.log(
            "INVENTORY RESERVED:",
            {
                inventoryId:
                    reservedInventoryId,
                productId,
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


                    return balance - price;

                }
            );


        if (
            !walletTransaction.committed
        ) {

            /* Restore inventory */

            await reservedItemRef.transaction(
                (currentItem) => {

                    if (
                        currentItem &&
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


            const latest =
                await walletRef.once("value");


            const balance =
                Number(latest.val()) || 0;


            return sendJson(
                res,
                400,
                {
                    success: false,

                    message:
                        `Insufficient wallet balance. Your balance is ₦${money(balance)}, but this product costs ₦${money(price)}.`
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
           DELIVERY
        ================================= */

        const deliveryDetails =
            reservedInventory.details !==
            undefined
                ? String(
                    reservedInventory.details
                )
                : "";


        /* =================================
           ORDER
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


            /* Refund */

            await walletRef.transaction(
                (currentBalance) => {

                    return (
                        (Number(currentBalance) || 0)
                        + price
                    );

                }
            );


            /* Restore item */

            await reservedItemRef.transaction(
                (currentItem) => {

                    if (
                        currentItem &&
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
           SOLD
        ================================= */

        const soldTransaction =
            await reservedItemRef.transaction(
                (currentItem) => {

                    if (
                        !currentItem ||
                        currentItem.status !==
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


        if (
            !soldTransaction.committed
        ) {

            console.error(
                "COULD NOT MARK ITEM SOLD:",
                {
                    productId,
                    inventoryId:
                        reservedInventoryId,
                    orderId
                }
            );

        }


        /* =================================
           SUCCESS
        ================================= */

        console.log(
            "PURCHASE COMPLETED:",
            {
                uid,
                productId,
                inventoryId:
                    reservedInventoryId,
                orderId,
                price
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
            "PURCHASE API ERROR:",
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
