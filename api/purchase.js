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

function send(res, status, data) {

    return res
        .status(status)
        .json(data);

}


function money(value) {

    return Number(value).toLocaleString(
        "en-NG",
        {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }
    );

}


/*
   An inventory item is available when:

   status = "available"

   OR status is missing/empty.

   Sold and processing items are NOT available.
*/

function isAvailable(item) {

    if (
        !item ||
        typeof item !== "object"
    ) {

        return false;

    }


    const status =
        typeof item.status === "string"
            ? item.status.trim().toLowerCase()
            : "";


    if (
        status === "sold" ||
        status === "processing"
    ) {

        return false;

    }


    return (
        status === "" ||
        status === "available"
    );

}


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

                status:
                    "available",

                processingBy:
                    null,

                processingAt:
                    null

            });


            console.log(
                "INVENTORY RESTORED:",
                itemRef.key
            );

        }

    }
    catch (error) {

        console.error(
            "RESTORE INVENTORY ERROR:",
            error
        );

    }

}


/* =========================================================
   DECREASE PRODUCT STOCK
========================================================= */

/*
   products/{productId}/stock is the customer-facing
   available stock counter.

   Example:

   Before purchase:
   stock = 20

   After purchase:
   stock = 19

   The transaction prevents two simultaneous purchases
   from incorrectly using the same stock number.
*/

async function decreaseProductStock(
    productId
) {

    const stockRef =
        db.ref(
            "products/" +
            productId +
            "/stock"
        );


    const stockSnapshot =
        await stockRef.once(
            "value"
        );


    const originalValue =
        stockSnapshot.val();


    const originalStock =
        Number(originalValue);


    /*
       If stock does not exist yet, we do not invent a
       number here.

       The inventory itself is still the real source of
       purchasable items.
    */

    if (
        !Number.isFinite(
            originalStock
        )
    ) {

        throw new Error(
            "Product stock is not configured for this product."
        );

    }


    if (
        originalStock <= 0
    ) {

        throw new Error(
            "Product stock is already zero."
        );

    }


    const transaction =
        await stockRef.transaction(
            (currentValue) => {

                const value =
                    currentValue === null ||
                    currentValue === undefined
                        ? originalValue
                        : currentValue;


                const stock =
                    Number(value);


                if (
                    !Number.isFinite(stock)
                ) {

                    return;

                }


                if (
                    stock <= 0
                ) {

                    return;

                }


                return Math.max(
                    0,
                    stock - 1
                );

            }
        );


    if (
        !transaction.committed
    ) {

        throw new Error(
            "Product stock could not be updated."
        );

    }


    const newStock =
        Number(
            transaction.snapshot.val()
        );


    console.log(
        "PRODUCT STOCK UPDATED:",
        {
            productId,
            previousStock:
                originalStock,
            newStock
        }
    );


    return {

        previousStock:
            originalStock,

        newStock

    };

}


/* =========================================================
   RESTORE PRODUCT STOCK
========================================================= */

async function restoreProductStock(
    productId
) {

    try {

        const stockRef =
            db.ref(
                "products/" +
                productId +
                "/stock"
            );


        await stockRef.transaction(
            (currentValue) => {

                const stock =
                    Number(currentValue);


                if (
                    !Number.isFinite(stock)
                ) {

                    return;

                }


                return stock + 1;

            }
        );


        console.log(
            "PRODUCT STOCK RESTORED:",
            productId
        );

    }
    catch (error) {

        console.error(
            "RESTORE PRODUCT STOCK ERROR:",
            error
        );

    }

}


/* =========================================================
   MAIN PURCHASE API
========================================================= */

module.exports = async function handler(
    req,
    res
) {

    if (
        req.method !== "POST"
    ) {

        return send(
            res,
            405,
            {
                success:
                    false,

                message:
                    "Method not allowed."
            }
        );

    }


    let uid = null;
    let productId = null;
    let price = 0;

    let reservedInventoryId = null;
    let reservedInventory = null;

    let walletCharged = false;
    let orderCreated = false;
    let productStockDecreased = false;


    try {

        /* =====================================================
           AUTHENTICATION
        ===================================================== */

        const authorization =
            req.headers.authorization || "";


        if (
            !authorization.startsWith(
                "Bearer "
            )
        ) {

            return send(
                res,
                401,
                {
                    success:
                        false,

                    message:
                        "Please log in before purchasing."
                }
            );

        }


        const token =
            authorization
                .substring(7)
                .trim();


        if (!token) {

            return send(
                res,
                401,
                {
                    success:
                        false,

                    message:
                        "Authentication token is missing."
                }
            );

        }


        const decoded =
            await auth.verifyIdToken(
                token
            );


        uid =
            decoded.uid;


        const email =
            decoded.email || "";


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


        /* =====================================================
           PRODUCT ID
        ===================================================== */

        productId =
            req.body &&
            req.body.productId
                ? String(
                    req.body.productId
                ).trim()
                : "";


        if (!productId) {

            return send(
                res,
                400,
                {
                    success:
                        false,

                    message:
                        "Product ID is required."
                }
            );

        }


        console.log(
            "PRODUCT:",
            productId
        );


        /* =====================================================
           GET PRODUCT
        ===================================================== */

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

            return send(
                res,
                404,
                {
                    success:
                        false,

                    message:
                        "Product not found."
                }
            );

        }


        const product =
            productSnapshot.val();


        console.log(
            "PRODUCT FOUND:",
            product.name ||
            "Unnamed Product"
        );


        if (
            product.active === false
        ) {

            return send(
                res,
                400,
                {
                    success:
                        false,

                    message:
                        "This product is currently unavailable."
                }
            );

        }


        price =
            Number(
                product.price
            );


        if (
            !Number.isFinite(price) ||
            price <= 0
        ) {

            return send(
                res,
                400,
                {
                    success:
                        false,

                    message:
                        "This product has an invalid price."
                }
            );

        }


        console.log(
            "PRODUCT PRICE:",
            price
        );


        /* =====================================================
           INVENTORY
        ===================================================== */

        const inventoryRef =
            db.ref(
                "inventory/" +
                productId
            );


        const inventorySnapshot =
            await inventoryRef.once(
                "value"
            );


        if (
            !inventorySnapshot.exists()
        ) {

            return send(
                res,
                409,
                {
                    success:
                        false,

                    message:
                        "This product is currently out of stock."
                }
            );

        }


        const inventory =
            inventorySnapshot.val();


        if (
            !inventory ||
            typeof inventory !== "object"
        ) {

            return send(
                res,
                409,
                {
                    success:
                        false,

                    message:
                        "This product is currently out of stock."
                }
            );

        }


        const entries =
            Object.entries(
                inventory
            );


        console.log(
            "TOTAL INVENTORY:",
            entries.length
        );


        let availableCount = 0;


        for (
            const [inventoryId, item]
            of entries
        ) {

            const available =
                isAvailable(item);


            console.log(
                "ITEM:",
                inventoryId,
                "STATUS:",
                item &&
                item.status,
                "AVAILABLE:",
                available
            );


            if (available) {

                availableCount++;

            }

        }


        console.log(
            "AVAILABLE COUNT:",
            availableCount
        );


        if (
            availableCount === 0
        ) {

            return send(
                res,
                409,
                {
                    success:
                        false,

                    message:
                        "This product is currently out of stock."
                }
            );

        }


        /* =====================================================
           FIND + ATOMICALLY RESERVE INVENTORY
        ===================================================== */

        for (
            const [inventoryId]
            of entries
        ) {

            const itemRef =
                inventoryRef.child(
                    inventoryId
                );


            const latestSnapshot =
                await itemRef.once(
                    "value"
                );


            if (
                !latestSnapshot.exists()
            ) {

                continue;

            }


            const latestItem =
                latestSnapshot.val();


            if (
                !isAvailable(
                    latestItem
                )
            ) {

                console.log(
                    "SKIPPING UNAVAILABLE ITEM:",
                    inventoryId,
                    latestItem &&
                    latestItem.status
                );

                continue;

            }


            console.log(
                "CHECKING INVENTORY:",
                {
                    inventoryId,
                    status:
                        latestItem.status
                }
            );


            console.log(
                "TRYING TO RESERVE:",
                inventoryId
            );


            const transaction =
                await itemRef.transaction(
                    (currentValue) => {

                        const item =
                            currentValue === null ||
                            currentValue === undefined
                                ? latestItem
                                : currentValue;


                        if (
                            !isAvailable(item)
                        ) {

                            return;

                        }


                        return {

                            ...item,

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
                        transaction.committed
                }
            );


            if (
                !transaction.committed
            ) {

                console.log(
                    "ITEM WAS TAKEN BY ANOTHER REQUEST:",
                    inventoryId
                );


                continue;

            }


            reservedInventoryId =
                inventoryId;


            reservedInventory =
                transaction.snapshot.val();


            console.log(
                "INVENTORY RESERVED:",
                reservedInventoryId
            );


            break;

        }


        /* =====================================================
           NO ITEM COULD BE RESERVED
        ===================================================== */

        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {

            console.error(
                "NO PURCHASABLE INVENTORY:",
                {
                    productId,
                    total:
                        entries.length,
                    available:
                        availableCount
                }
            );


            return send(
                res,
                409,
                {
                    success:
                        false,

                    message:
                        "This product is currently out of stock. Please try again."
                }
            );

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


        const walletSnapshot =
            await walletRef.once(
                "value"
            );


        if (
            !walletSnapshot.exists()
        ) {

            await restoreInventory(
                inventoryRef.child(
                    reservedInventoryId
                ),
                uid
            );


            return send(
                res,
                400,
                {
                    success:
                        false,

                    message:
                        "Your wallet balance could not be found."
                }
            );

        }


        const currentBalance =
            Number(
                walletSnapshot.val()
            );


        console.log(
            "WALLET BALANCE:",
            currentBalance
        );


        console.log(
            "PRICE:",
            price
        );


        if (
            !Number.isFinite(
                currentBalance
            )
        ) {

            await restoreInventory(
                inventoryRef.child(
                    reservedInventoryId
                ),
                uid
            );


            return send(
                res,
                400,
                {
                    success:
                        false,

                    message:
                        "Your wallet balance is invalid."
                }
            );

        }


        if (
            currentBalance < price
        ) {

            await restoreInventory(
                inventoryRef.child(
                    reservedInventoryId
                ),
                uid
            );


            return send(
                res,
                400,
                {
                    success:
                        false,

                    message:
                        `Insufficient wallet balance. Your balance is ₦${money(currentBalance)}, but this product costs ₦${money(price)}.`
                }
            );

        }


        /* =====================================================
           CHARGE WALLET ATOMICALLY
        ===================================================== */

        console.log(
            "CHARGING WALLET..."
        );


        const walletTransaction =
            await walletRef.transaction(
                (currentValue) => {

                    const value =
                        currentValue === null ||
                        currentValue === undefined
                            ? walletSnapshot.val()
                            : currentValue;


                    const balance =
                        Number(value);


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
            "WALLET COMMITTED:",
            walletTransaction.committed
        );


        /* =====================================================
           WALLET CHARGE FAILED
        ===================================================== */

        if (
            !walletTransaction.committed
        ) {

            const latestWallet =
                await walletRef.once(
                    "value"
                );


            const latestBalance =
                Number(
                    latestWallet.val()
                );


            await restoreInventory(
                inventoryRef.child(
                    reservedInventoryId
                ),
                uid
            );


            if (
                Number.isFinite(
                    latestBalance
                ) &&
                latestBalance < price
            ) {

                return send(
                    res,
                    400,
                    {
                        success:
                            false,

                        message:
                            `Insufficient wallet balance. Your balance is ₦${money(latestBalance)}, but this product costs ₦${money(price)}.`
                    }
                );

            }


            return send(
                res,
                500,
                {
                    success:
                        false,

                    message:
                        "Your wallet could not be charged. Please try again."
                }
            );

        }


        walletCharged = true;


        const newBalance =
            Number(
                walletTransaction
                    .snapshot
                    .val()
            );


        console.log(
            "NEW WALLET BALANCE:",
            newBalance
        );


        /* =====================================================
           DELIVERY DETAILS
        ===================================================== */

        const deliveryDetails =
            reservedInventory.details !== undefined
                ? String(
                    reservedInventory.details
                )
                : "";


        /* =====================================================
           CREATE ORDER
        ===================================================== */

        const orderRef =
            db.ref(
                "orders"
            ).push();


        const orderId =
            orderRef.key;


        const order = {

            uid,

            email,

            productId,

            productName:
                product.name ||
                "Unnamed Product",

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


            orderCreated = true;


            console.log(
                "ORDER CREATED:",
                orderId
            );

        }
        catch (orderError) {

            console.error(
                "ORDER CREATION ERROR:",
                orderError
            );


            /*
              Refund wallet.
            */

            try {

                await walletRef.transaction(
                    (currentValue) => {

                        const value =
                            currentValue === null ||
                            currentValue === undefined
                                ? newBalance
                                : currentValue;


                        const balance =
                            Number(value);


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

            }
            catch (refundError) {

                console.error(
                    "REFUND ERROR:",
                    refundError
                );

            }


            walletCharged = false;


            /*
              Restore inventory.
            */

            await restoreInventory(
                inventoryRef.child(
                    reservedInventoryId
                ),
                uid
            );


            return send(
                res,
                500,
                {
                    success:
                        false,

                    message:
                        "Purchase could not be completed. Your wallet has been refunded."
                }
            );

        }


        /* =====================================================
           DECREASE CUSTOMER-FACING STOCK
        ===================================================== */

        console.log(
            "DECREASING PRODUCT STOCK..."
        );


        try {

            await decreaseProductStock(
                productId
            );


            productStockDecreased = true;

        }
        catch (stockError) {

            console.error(
                "PRODUCT STOCK UPDATE ERROR:",
                stockError
            );


            /*
              The order has already been created and wallet
              already charged, so we must roll the purchase
              back if stock cannot be updated.
            */

            try {

                await orderRef.remove();

                orderCreated = false;

                console.log(
                    "ORDER ROLLED BACK:",
                    orderId
                );

            }
            catch (deleteOrderError) {

                console.error(
                    "ORDER ROLLBACK ERROR:",
                    deleteOrderError
                );

            }


            /*
              Refund wallet.
            */

            try {

                await walletRef.transaction(
                    (currentValue) => {

                        const value =
                            currentValue === null ||
                            currentValue === undefined
                                ? newBalance
                                : currentValue;


                        const balance =
                            Number(value);


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


                walletCharged = false;


                console.log(
                    "WALLET REFUNDED AFTER STOCK ERROR"
                );

            }
            catch (refundError) {

                console.error(
                    "STOCK ERROR REFUND FAILED:",
                    refundError
                );

            }


            /*
              Restore inventory.
            */

            await restoreInventory(
                inventoryRef.child(
                    reservedInventoryId
                ),
                uid
            );


            return send(
                res,
                500,
                {
                    success:
                        false,

                    message:
                        "Purchase could not be completed because stock could not be updated. Your wallet has been refunded."
                }
            );

        }


        /* =====================================================
           MARK INVENTORY SOLD
        ===================================================== */

        const reservedRef =
            inventoryRef.child(
                reservedInventoryId
            );


        try {

            await reservedRef.update({

                status:
                    "sold",

                soldTo:
                    uid,

                soldOrderId:
                    orderId,

                soldAt:
                    Date.now(),

                processingBy:
                    null,

                processingAt:
                    null

            });


            console.log(
                "INVENTORY SOLD:",
                reservedInventoryId
            );

        }
        catch (inventorySoldError) {

            console.error(
                "MARK INVENTORY SOLD ERROR:",
                inventorySoldError
            );


            /*
              Stock was already decreased, so restore it.
            */

            if (
                productStockDecreased
            ) {

                await restoreProductStock(
                    productId
                );

                productStockDecreased =
                    false;

            }


            /*
              Delete order.
            */

            try {

                await orderRef.remove();

                orderCreated = false;

            }
            catch (error) {

                console.error(
                    "ORDER DELETE ERROR:",
                    error
                );

            }


            /*
              Refund wallet.
            */

            if (
                walletCharged
            ) {

                try {

                    await walletRef.transaction(
                        (currentValue) => {

                            const value =
                                currentValue === null ||
                                currentValue === undefined
                                    ? newBalance
                                    : currentValue;


                            const balance =
                                Number(value);


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


                    walletCharged =
                        false;

                }
                catch (refundError) {

                    console.error(
                        "INVENTORY ERROR REFUND FAILED:",
                        refundError
                    );

                }

            }


            /*
              Restore reserved inventory.
            */

            await restoreInventory(
                reservedRef,
                uid
            );


            return send(
                res,
                500,
                {
                    success:
                        false,

                    message:
                        "Purchase could not be completed. Your wallet has been refunded."
                }
            );

        }


        /* =====================================================
           PURCHASE SUCCESS
        ===================================================== */

        console.log(
            "PURCHASE COMPLETED:",
            orderId
        );


        console.log(
            "PRODUCT STOCK DECREASED:",
            productId
        );


        console.log(
            "================================="
        );


        return send(
            res,
            200,
            {

                success:
                    true,

                message:
                    "Purchase completed successfully.",

                orderId,

                balance:
                    newBalance,

                deliveryDetails

            }
        );

    }
    catch (error) {

        console.error(
            "PURCHASE API ERROR:",
            error
        );


        /* =====================================================
           FINAL ERROR CLEANUP
        ===================================================== */

        /*
          If product stock was decreased but something later
          failed, restore the stock.
        */

        if (
            productStockDecreased &&
            productId
        ) {

            try {

                await restoreProductStock(
                    productId
                );

            }
            catch (stockRestoreError) {

                console.error(
                    "FINAL STOCK RESTORE ERROR:",
                    stockRestoreError
                );

            }

        }


        /*
          If an order was created but the request failed
          afterwards, remove it.
        */

        if (
            orderCreated &&
            productId
        ) {

            /*
              We cannot safely reconstruct the orderRef here
              without keeping it outside the inner scope.
              Normal purchase errors happen before this point,
              so the explicit rollback blocks above handle
              the important cases.
            */

            console.error(
                "FINAL ERROR: Order may require manual review."
            );

        }


        /*
          Restore reserved inventory.
        */

        if (
            reservedInventoryId &&
            uid &&
            productId
        ) {

            try {

                await restoreInventory(

                    db.ref(
                        "inventory/" +
                        productId +
                        "/" +
                        reservedInventoryId
                    ),

                    uid

                );

            }
            catch (restoreError) {

                console.error(
                    "FINAL RESTORE ERROR:",
                    restoreError
                );

            }

        }


        return send(
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
