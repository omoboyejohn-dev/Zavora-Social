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


const adminAuth =
    getAuth();

const db =
    getDatabase();


/* =========================================================
   HELPERS
========================================================= */

function sendJson(
    res,
    status,
    data
) {

    return res
        .status(status)
        .json(data);

}


function formatMoney(
    amount
) {

    return Number(
        amount
    ).toLocaleString(
        "en-NG",
        {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }
    );

}


/* =========================================================
   INVENTORY STATUS
========================================================= */

function isPurchasable(
    item
) {

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


    /*
       Never sell an item that is already sold.
    */

    if (
        status === "sold"
    ) {

        return false;

    }


    /*
       Never sell an item currently being processed.
    */

    if (
        status === "processing"
    ) {

        return false;

    }


    /*
       available
       AVAILABLE
       Available
       empty/legacy status

       are all accepted.
    */

    return true;

}


/* =========================================================
   PURCHASE HANDLER
========================================================= */

module.exports = async function handler(
    req,
    res
) {


    /* =====================================================
       METHOD CHECK
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
       ENVIRONMENT CHECK
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


        if (
            !idToken
        ) {

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


        if (
            !productId
        ) {

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
           PRODUCT LOOKUP
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
           PRODUCT ACTIVE
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
           INVENTORY LOOKUP
        ================================================= */

        const inventoryRef =
            db.ref(
                "inventory/" +
                productId
            );


        const inventorySnapshot =
            await inventoryRef.once(
                "value"
            );


        const inventory =
            inventorySnapshot.val();


        /* =================================================
           NO INVENTORY AT ALL
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


        console.log(
            "TOTAL INVENTORY ITEMS:",
            inventoryEntries.length
        );


        /* =================================================
           INVENTORY DIAGNOSTICS
        ================================================= */

        let availableCount =
            0;

        let soldCount =
            0;

        let processingCount =
            0;

        let otherCount =
            0;


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
                "INVENTORY ITEM:",
                {
                    inventoryId:
                        inventoryId,

                    status:
                        status || "(empty)"
                }
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
            "INVENTORY STATUS SUMMARY"
        );

        console.log({

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
           RESERVE INVENTORY
        ================================================= */

        let reservedInventoryId =
            null;

        let reservedInventory =
            null;


        for (
            const [
                inventoryId
            ]
            of inventoryEntries
        ) {


            const itemRef =
                inventoryRef.child(
                    inventoryId
                );


            /*
               IMPORTANT:

               Read the exact child first.

               This prevents the transaction from
               incorrectly receiving null because the
               child was not locally cached.
            */

            const itemSnapshot =
                await itemRef.once(
                    "value"
                );


            if (
                !itemSnapshot.exists()
            ) {

                continue;

            }


            const currentItem =
                itemSnapshot.val();


            console.log(
                "CHECKING INVENTORY:",
                {
                    inventoryId:
                        inventoryId,

                    status:
                        currentItem &&
                        currentItem.status
                            ? currentItem.status
                            : "(empty)"
                }
            );


            if (
                !isPurchasable(
                    currentItem
                )
            ) {

                continue;

            }


            console.log(
                "TRYING TO RESERVE:",
                inventoryId
            );


            /*
               Transaction is now performed against
               an exact item that we just read.
            */

            const transactionResult =
                await itemRef.transaction(
                    (
                        currentValue
                    ) => {


                        /*
                           If another process removed
                           the item, abort.
                        */

                        if (
                            currentValue === null ||
                            currentValue === undefined
                        ) {

                            return;

                        }


                        if (
                            typeof currentValue !==
                            "object"
                        ) {

                            return;

                        }


                        /*
                           Check status again inside
                           the transaction.

                           This protects against two
                           customers buying the same item.
                        */

                        if (
                            !isPurchasable(
                                currentValue
                            )
                        ) {

                            return;

                        }


                        return {

                            ...currentValue,

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
                    inventoryId:
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
           RESERVATION FAILED
        ================================================= */

        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {

            console.error(
                "NO PURCHASABLE INVENTORY.",
                {
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
            "Inventory ID:",
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


        /*
           IMPORTANT:

           Read the exact wallet location first.

           This prevents the transaction from treating
           an uncached existing wallet as null/₦0.
        */

        const walletSnapshot =
            await walletRef.once(
                "value"
            );


        if (
            !walletSnapshot.exists()
        ) {

            console.error(
                "WALLET BALANCE DOES NOT EXIST:",
                uid
            );


            /*
               Restore inventory because purchase
               cannot continue.
            */

            await reservedItemRef.transaction(
                (
                    currentItem
                ) => {

                    if (
                        !currentItem ||
                        typeof currentItem !== "object"
                    ) {

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
                400,
                {
                    success: false,

                    message:
                        "Your wallet balance could not be found."
                }
            );

        }


        const initialWalletBalance =
            Number(
                walletSnapshot.val()
            );


        console.log(
            "WALLET READ BEFORE TRANSACTION:",
            initialWalletBalance
        );


        if (
            !Number.isFinite(
                initialWalletBalance
            )
        ) {

            console.error(
                "INVALID WALLET BALANCE:",
                walletSnapshot.val()
            );


            await reservedItemRef.transaction(
                (
                    currentItem
                ) => {

                    if (
                        !currentItem ||
                        typeof currentItem !== "object"
                    ) {

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
                400,
                {
                    success: false,

                    message:
                        "Your wallet balance is invalid."
                }
            );

        }


        /* =================================================
           CHECK BALANCE BEFORE TRANSACTION
        ================================================= */

        if (
            initialWalletBalance < price
        ) {

            console.log(
                "INSUFFICIENT WALLET BALANCE:",
                {
                    balance:
                        initialWalletBalance,

                    price:
                        price
                }
            );


            /*
               Restore inventory.
            */

            await reservedItemRef.transaction(
                (
                    currentItem
                ) => {

                    if (
                        !currentItem ||
                        typeof currentItem !== "object"
                    ) {

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
                400,
                {
                    success: false,

                    message:
                        `Insufficient wallet balance. Your balance is ₦${formatMoney(initialWalletBalance)}, but this product costs ₦${formatMoney(price)}.`
                }
            );

        }


        /* =================================================
           DEDUCT WALLET
        ================================================= */

        console.log(
            "ATTEMPTING WALLET TRANSACTION:",
            {
                currentBalance:
                    initialWalletBalance,

                price:
                    price,

                newBalance:
                    initialWalletBalance - price

            }
        );


        const walletTransaction =
            await walletRef.transaction(
                (
                    currentBalance
                ) => {


                    /*
                       Do NOT treat null as ₦0.

                       If Firebase gives us null here,
                       abort this attempt rather than
                       accidentally writing a wrong balance.
                    */

                    if (
                        currentBalance === null ||
                        currentBalance === undefined
                    ) {

                        return;

                    }


                    const balance =
                        Number(
                            currentBalance
                        );


                    if (
                        !Number.isFinite(
                            balance
                        )
                    ) {

                        return;

                    }


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


        console.log(
            "WALLET TRANSACTION RESULT:",
            {
                committed:
                    walletTransaction.committed,

                balance:
                    walletTransaction
                        .snapshot
                        .val()
            }
        );


        /* =================================================
           WALLET TRANSACTION FAILED
        ================================================= */

        if (
            !walletTransaction.committed
        ) {


            /*
               Read the real current balance again.
            */

            const latestWalletSnapshot =
                await walletRef.once(
                    "value"
                );


            const latestBalance =
                Number(
                    latestWalletSnapshot.val()
                );


            console.error(
                "WALLET TRANSACTION DID NOT COMMIT:",
                {
                    latestBalance:
                        latestBalance,

                    price:
                        price
                }
            );


            /*
               Restore inventory.
            */

            await reservedItemRef.transaction(
                (
                    currentItem
                ) => {

                    if (
                        !currentItem ||
                        typeof currentItem !== "object"
                    ) {

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


            /*
               If the latest balance really is enough,
               this was a transaction problem rather
               than an insufficient-balance problem.
            */

            if (
                Number.isFinite(
                    latestBalance
                ) &&
                latestBalance >= price
            ) {

                return sendJson(
                    res,
                    500,
                    {
                        success: false,

                        message:
                            "The wallet transaction could not be completed. Your wallet was not charged. Please try again."
                    }
                );

            }


            return sendJson(
                res,
                400,
                {
                    success: false,

                    message:
                        `Insufficient wallet balance. Your balance is ₦${formatMoney(latestBalance || 0)}, but this product costs ₦${formatMoney(price)}.`
                }
            );

        }


        /* =================================================
           NEW BALANCE
        ================================================= */

        const newBalance =
            Number(
                walletTransaction
                    .snapshot
                    .val()
            );


        console.log(
            "WALLET SUCCESS:",
            {
                oldBalance:
                    initialWalletBalance,

                price:
                    price,

                newBalance:
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
            "DELIVERY DETAILS:",
            deliveryDetails
                ? "FOUND"
                : "EMPTY"
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
                (
                    currentBalance
                ) => {

                    if (
                        currentBalance === null ||
                        currentBalance === undefined
                    ) {

                        return;

                    }


                    const balance =
                        Number(
                            currentBalance
                        );


                    if (
                        !Number.isFinite(
                            balance
                        )
                    ) {

                        return;

                    }


                    return (
                        balance + price
                    );

                }
            );


            /*
               Restore inventory.
            */

            await reservedItemRef.transaction(
                (
                    currentItem
                ) => {

                    if (
                        !currentItem ||
                        typeof currentItem !== "object"
                    ) {

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
                        "Your purchase could not be completed. Your wallet has been restored."
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
                (
                    currentItem
                ) => {


                    if (
                        currentItem === null ||
                        currentItem === undefined
                    ) {

                        return;

                    }


                    if (
                        typeof currentItem !==
                        "object"
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


        console.log(
            "SOLD TRANSACTION:",
            {
                committed:
                    soldTransaction.committed,

                inventoryId:
                    reservedInventoryId

            }
        );


        /* =================================================
           SOLD CHECK
        ================================================= */

        if (
            !soldTransaction.committed
        ) {

            console.error(
                "ORDER CREATED BUT INVENTORY COULD NOT BE MARKED SOLD.",
                {
                    productId:
                        productId,

                    inventoryId:
                        reservedInventoryId,

                    orderId:
                        orderId,

                    uid:
                        uid

                }
            );


            /*
               Do not charge again.

               The purchase/order already exists.
            */

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
           FINAL SUCCESS
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

            oldBalance:
                initialWalletBalance,

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
            "MESSAGE:",
            error &&
            error.message
        );

        console.error(
            "STACK:",
            error &&
            error.stack
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
