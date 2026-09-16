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

    return Number(amount || 0).toLocaleString(
        "en-NG",
        {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }
    );

}


/* =========================================================
   INVENTORY CHECK
========================================================= */

/*
   Purchasable inventory:

   available
   AVAILABLE
   Available
   empty/legacy status
   any other status

   NOT purchasable:

   sold
   processing
*/

function isPurchasable(item) {

    if (
        !item ||
        typeof item !== "object"
    ) {

        return false;

    }


    const status =
        typeof item.status === "string"
            ? item.status
                .trim()
                .toLowerCase()
            : "";


    if (
        status === "sold"
    ) {

        return false;

    }


    if (
        status === "processing"
    ) {

        return false;

    }


    return true;

}


/* =========================================================
   PURCHASE HANDLER
========================================================= */

module.exports = async function handler(req, res) {


    /* =====================================================
       METHOD
    ===================================================== */

    if (
        req.method !== "POST"
    ) {

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


    /* =====================================================
       ENVIRONMENT
    ===================================================== */

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
            "PURCHASE START"
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
           PRODUCT
        ================================================= */

        const productRef =
            db.ref(
                "products/" +
                productId
            );


        const productSnapshot =
            await productRef.once(
                "value"
            );


        if (
            !productSnapshot.exists()
        ) {

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
           ACTIVE CHECK
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
           PRICE
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
                product.price
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
           INVENTORY REFERENCE
        ================================================= */

        const inventoryRef =
            db.ref(
                "inventory/" +
                productId
            );


        /* =================================================
           INVENTORY SNAPSHOT
        ================================================= */

        const inventorySnapshot =
            await inventoryRef.once(
                "value"
            );


        const inventory =
            inventorySnapshot.val();


        /* =================================================
           NO INVENTORY NODE
        ================================================= */

        if (
            !inventory ||
            typeof inventory !== "object"
        ) {

            console.error(
                "NO INVENTORY NODE:",
                productId
            );

            return sendJson(
                res,
                409,
                {
                    success: false,

                    message:
                        "This product has no inventory items.",

                    debug: {

                        productId:
                            productId,

                        total:
                            0,

                        available:
                            0,

                        sold:
                            0,

                        processing:
                            0,

                        other:
                            0

                    }

                }
            );

        }


        const inventoryEntries =
            Object.entries(
                inventory
            );


        /* =================================================
           DIAGNOSTIC COUNTS
        ================================================= */

        let availableCount = 0;

        let soldCount = 0;

        let processingCount = 0;

        let otherCount = 0;


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


            const status =
                typeof inventoryItem.status === "string"
                    ? inventoryItem.status
                        .trim()
                        .toLowerCase()
                    : "";


            console.log(
                "INVENTORY:",
                inventoryId,
                "STATUS:",
                status || "(empty)"
            );


            if (
                status === "sold"
            ) {

                soldCount++;

            }

            else if (
                status === "processing"
            ) {

                processingCount++;

            }

            else if (
                status === "available" ||
                status === ""
            ) {

                availableCount++;

            }

            else {

                otherCount++;

            }

        }


        console.log(
            "========================================"
        );

        console.log(
            "INVENTORY DIAGNOSTIC"
        );

        console.log({

            productId:
                productId,

            total:
                inventoryEntries.length,

            available:
                availableCount,

            sold:
                soldCount,

            processing:
                processingCount,

            other:
                otherCount

        });

        console.log(
            "========================================"
        );


        /* =================================================
           RESERVATION TOKEN
        ================================================= */

        const reservationToken =
            uid +
            "_" +
            Date.now() +
            "_" +
            Math.random()
                .toString(36)
                .substring(2);


        /* =================================================
           ATOMIC INVENTORY RESERVATION
           
           IMPORTANT:
           We now transact on the ENTIRE inventory node.

           This avoids the previous situation where an
           individual inventory transaction could return
           committed:false even though the item was
           available.
        ================================================= */

        const reservationTransaction =
            await inventoryRef.transaction(
                (currentInventory) => {

                    if (
                        !currentInventory ||
                        typeof currentInventory !== "object"
                    ) {

                        return currentInventory;

                    }


                    const updatedInventory =
                        {
                            ...currentInventory
                        };


                    let foundItem = false;


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
                            foundItem
                        ) {

                            break;

                        }


                        if (
                            !isPurchasable(
                                inventoryItem
                            )
                        ) {

                            continue;

                        }


                        updatedInventory[inventoryId] = {

                            ...inventoryItem,

                            status:
                                "processing",

                            processingBy:
                                uid,

                            processingToken:
                                reservationToken,

                            processingAt:
                                Date.now()

                        };


                        foundItem = true;

                    }


                    /*
                       IMPORTANT:
                       We always return an object.

                       We do NOT return undefined when no item
                       is found.

                       This makes the transaction complete
                       normally and lets us inspect the final
                       snapshot afterwards.
                    */

                    return updatedInventory;

                }
            );


        console.log(
            "INVENTORY TRANSACTION:",
            {
                committed:
                    reservationTransaction.committed
            }
        );


        /* =================================================
           FIND OUR RESERVED ITEM
        ================================================= */

        let reservedInventoryId =
            null;


        let reservedInventory =
            null;


        if (
            reservationTransaction.committed
        ) {

            const reservedInventorySnapshot =
                reservationTransaction
                    .snapshot
                    .val();


            if (
                reservedInventorySnapshot &&
                typeof reservedInventorySnapshot === "object"
            ) {

                for (
                    const [
                        inventoryId,
                        inventoryItem
                    ]
                    of Object.entries(
                        reservedInventorySnapshot
                    )
                ) {

                    if (
                        inventoryItem &&
                        inventoryItem.processingToken ===
                            reservationToken
                    ) {

                        reservedInventoryId =
                            inventoryId;

                        reservedInventory =
                            inventoryItem;

                        break;

                    }

                }

            }

        }


        /* =================================================
           NO INVENTORY
        ================================================= */

        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {

            console.error(
                "RESERVATION FAILED."
            );


            return sendJson(
                res,
                409,
                {
                    success: false,

                    message:
                        `No purchasable inventory. Total: ${inventoryEntries.length}, Available: ${availableCount}, Sold: ${soldCount}, Processing: ${processingCount}, Other: ${otherCount}.`,

                    debug: {

                        productId:
                            productId,

                        total:
                            inventoryEntries.length,

                        available:
                            availableCount,

                        sold:
                            soldCount,

                        processing:
                            processingCount,

                        other:
                            otherCount

                    }

                }
            );

        }


        console.log(
            "========================================"
        );

        console.log(
            "INVENTORY RESERVED"
        );

        console.log(
            "INVENTORY ID:",
            reservedInventoryId
        );

        console.log(
            "========================================"
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
           INSUFFICIENT WALLET
        ================================================= */

        if (
            !walletTransaction.committed
        ) {

            console.log(
                "INSUFFICIENT WALLET."
            );


            /*
               Restore inventory.
            */

            await reservedItemRef.transaction(
                (currentItem) => {

                    if (
                        !currentItem ||
                        typeof currentItem !== "object"
                    ) {

                        return currentItem;

                    }


                    if (
                        currentItem.status ===
                            "processing" &&

                        currentItem.processingToken ===
                            reservationToken
                    ) {

                        const restoredItem =
                            {
                                ...currentItem
                            };


                        restoredItem.status =
                            "available";


                        delete restoredItem.processingBy;

                        delete restoredItem.processingToken;

                        delete restoredItem.processingAt;


                        return restoredItem;

                    }


                    return currentItem;

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
            "WALLET DEDUCTED:",
            price
        );

        console.log(
            "NEW BALANCE:",
            newBalance
        );


        /* =================================================
           DELIVERY DETAILS
        ================================================= */

        const deliveryDetails =
            reservedInventory.details !==
                undefined
                ? String(
                    reservedInventory.details
                )
                : "";


        console.log(
            "DELIVERY DETAILS:",
            deliveryDetails
                ? "FOUND"
                : "EMPTY"
        );


        /* =================================================
           ORDER ID
        ================================================= */

        const orderRef =
            db.ref(
                "orders"
            ).push();


        const orderId =
            orderRef.key;


        /* =================================================
           ORDER DATA
        ================================================= */

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

        catch (
            orderError
        ) {

            console.error(
                "ORDER CREATION FAILED:",
                orderError
            );


            /*
               Refund wallet.
            */

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


            /*
               Restore inventory.
            */

            await reservedItemRef.transaction(
                (currentItem) => {

                    if (
                        !currentItem ||
                        typeof currentItem !== "object"
                    ) {

                        return currentItem;

                    }


                    if (
                        currentItem.status ===
                            "processing" &&

                        currentItem.processingToken ===
                            reservationToken
                    ) {

                        const restoredItem =
                            {
                                ...currentItem
                            };


                        restoredItem.status =
                            "available";


                        delete restoredItem.processingBy;

                        delete restoredItem.processingToken;

                        delete restoredItem.processingAt;


                        return restoredItem;

                    }


                    return currentItem;

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
                        !currentItem ||
                        typeof currentItem !== "object"
                    ) {

                        return currentItem;

                    }


                    /*
                       Only the purchase that reserved
                       this item can mark it sold.
                    */

                    if (
                        currentItem.status !==
                            "processing"
                    ) {

                        return currentItem;

                    }


                    if (
                        currentItem.processingToken !==
                            reservationToken
                    ) {

                        return currentItem;

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

                    delete soldItem.processingToken;

                    delete soldItem.processingAt;


                    return soldItem;

                }
            );


        console.log(
            "SOLD TRANSACTION:",
            {
                committed:
                    soldTransaction.committed
            }
        );


        /* =================================================
           FINAL SUCCESS
        ================================================= */

        if (
            !soldTransaction.committed
        ) {

            console.error(
                "WARNING: ORDER CREATED BUT INVENTORY COULD NOT BE MARKED SOLD.",
                {
                    productId:
                        productId,

                    inventoryId:
                        reservedInventoryId,

                    orderId:
                        orderId
                }
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


        /* =================================================
           PURCHASE COMPLETED
        ================================================= */

        console.log(
            "========================================"
        );

        console.log(
            "PURCHASE COMPLETED SUCCESSFULLY"
        );

        console.log({

            uid:
                uid,

            email:
                email,

            productId:
                productId,

            inventoryId:
                reservedInventoryId,

            orderId:
                orderId,

            price:
                price,

            newBalance:
                newBalance

        });

        console.log(
            "========================================"
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


    /* =====================================================
       GLOBAL ERROR
    ===================================================== */

    catch (
        error
    ) {

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
            "ERROR MESSAGE:",
            error.message
        );

        console.error(
            "========================================"
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
