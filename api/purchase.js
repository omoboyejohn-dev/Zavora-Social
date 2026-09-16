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

function sendResponse(res, status, data) {

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
   Only inventory explicitly marked "sold" or "processing"
   is unavailable.

   Empty status is also treated as available so older inventory
   records can still be purchased.
*/

function isAvailableItem(item) {

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

    if (status === "sold") {
        return false;
    }

    if (status === "processing") {
        return false;
    }

    return true;

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

                status: "available",

                processingBy: null,

                processingAt: null

            });

            console.log(
                "INVENTORY RESTORED"
            );

        }

    }
    catch (error) {

        console.error(
            "INVENTORY RESTORE ERROR:",
            error
        );

    }

}


/* =========================================================
   REFUND WALLET
========================================================= */

async function refundWallet(
    walletRef,
    amount
) {

    try {

        console.log(
            "REFUNDING WALLET:",
            amount
        );


        const result =
            await walletRef.transaction(
                (currentValue) => {

                    /*
                     * If Firebase temporarily gives us null,
                     * do not overwrite the wallet with zero.
                     *
                     * Returning undefined aborts the transaction.
                     */
                    if (
                        currentValue === null ||
                        currentValue === undefined
                    ) {

                        return;

                    }


                    const balance =
                        Number(currentValue);


                    if (
                        !Number.isFinite(balance)
                    ) {

                        return;

                    }


                    return balance + amount;

                }
            );


        console.log(
            "REFUND COMMITTED:",
            result.committed
        );


        return result.committed;

    }
    catch (error) {

        console.error(
            "WALLET REFUND ERROR:",
            error
        );

        return false;

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

        return sendResponse(
            res,
            405,
            {
                success: false,
                message: "Method not allowed."
            }
        );

    }


    let uid = null;
    let productId = null;
    let price = 0;

    let reservedInventoryId = null;
    let reservedInventory = null;

    let walletRef = null;
    let walletCharged = false;


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

            return sendResponse(
                res,
                401,
                {
                    success: false,
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

            return sendResponse(
                res,
                401,
                {
                    success: false,
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

        console.log(
            "================================="
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

            return sendResponse(
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

            return sendResponse(
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
            !product ||
            typeof product !== "object"
        ) {

            return sendResponse(
                res,
                404,
                {
                    success: false,
                    message:
                        "Product information is invalid."
                }
            );

        }


        if (
            product.active === false
        ) {

            return sendResponse(
                res,
                400,
                {
                    success: false,
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

            return sendResponse(
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

            return sendResponse(
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


        if (
            !inventory ||
            typeof inventory !== "object"
        ) {

            return sendResponse(
                res,
                409,
                {
                    success: false,
                    message:
                        "This product is currently out of stock."
                }
            );

        }


        const inventoryEntries =
            Object.entries(
                inventory
            );


        console.log(
            "TOTAL INVENTORY:",
            inventoryEntries.length
        );


        let availableCount = 0;


        for (
            const [
                inventoryId,
                item
            ]
            of inventoryEntries
        ) {

            const available =
                isAvailableItem(
                    item
                );


            console.log(
                "INVENTORY ITEM:",
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

            return sendResponse(
                res,
                409,
                {
                    success: false,
                    message:
                        "This product is currently out of stock."
                }
            );

        }


        /* =====================================================
           FIND AND RESERVE ONE INVENTORY ITEM
        ===================================================== */

        let selectedItemRef = null;


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
             * Read the item directly from Firebase first.
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


            const latestItem =
                itemSnapshot.val();


            if (
                !isAvailableItem(
                    latestItem
                )
            ) {

                continue;

            }


            console.log(
                "TRYING TO RESERVE:",
                inventoryId
            );


            /*
             * Transaction prevents two customers from
             * taking the same inventory item.
             */

            const transactionResult =
                await itemRef.transaction(
                    (currentValue) => {

                        /*
                         * Firebase can initially provide null
                         * to the transaction callback.
                         *
                         * In that case, abort this particular
                         * inventory attempt instead of changing
                         * anything.
                         */

                        if (
                            currentValue === null ||
                            currentValue === undefined
                        ) {

                            return;

                        }


                        if (
                            !currentValue ||
                            typeof currentValue !== "object"
                        ) {

                            return;

                        }


                        if (
                            !isAvailableItem(
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
                "INVENTORY TRANSACTION:",
                inventoryId,
                "COMMITTED:",
                transactionResult.committed
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


                selectedItemRef =
                    itemRef;


                break;

            }

        }


        if (
            !reservedInventoryId ||
            !reservedInventory ||
            !selectedItemRef
        ) {

            return sendResponse(
                res,
                409,
                {
                    success: false,
                    message:
                        "This inventory item was just purchased. Please try again."
                }
            );

        }


        console.log(
            "INVENTORY RESERVED:",
            reservedInventoryId
        );


        /* =====================================================
           WALLET
        ===================================================== */

        walletRef =
            db.ref(
                "users/" +
                uid +
                "/walletBalance"
            );


        /*
         * IMPORTANT:
         *
         * Read the wallet before the transaction.
         */

        const walletSnapshot =
            await walletRef.once(
                "value"
            );


        if (
            !walletSnapshot.exists()
        ) {

            await restoreInventory(
                selectedItemRef,
                uid
            );


            return sendResponse(
                res,
                400,
                {
                    success: false,
                    message:
                        "Your wallet balance could not be found."
                }
            );

        }


        const verifiedBalance =
            Number(
                walletSnapshot.val()
            );


        console.log(
            "VERIFIED WALLET BALANCE:",
            verifiedBalance
        );


        console.log(
            "PRICE TO CHARGE:",
            price
        );


        if (
            !Number.isFinite(
                verifiedBalance
            )
        ) {

            await restoreInventory(
                selectedItemRef,
                uid
            );


            return sendResponse(
                res,
                400,
                {
                    success: false,
                    message:
                        "Your wallet balance is invalid."
                }
            );

        }


        if (
            verifiedBalance < price
        ) {

            await restoreInventory(
                selectedItemRef,
                uid
            );


            return sendResponse(
                res,
                400,
                {
                    success: false,
                    message:
                        `Insufficient wallet balance. Your balance is ₦${money(verifiedBalance)}, but this product costs ₦${money(price)}.`
                }
            );

        }


        /* =====================================================
           CHARGE WALLET
        ===================================================== */

        console.log(
            "================================="
        );

        console.log(
            "CHARGING WALLET"
        );

        console.log(
            "START BALANCE:",
            verifiedBalance
        );

        console.log(
            "CHARGE:",
            price
        );

        console.log(
            "EXPECTED BALANCE:",
            verifiedBalance - price
        );

        console.log(
            "================================="
        );


        /*
         * We use the verified balance if Firebase's first
         * transaction callback arrives with null.
         *
         * This specifically handles the serverless transaction
         * initialization problem that was causing your
         * "wallet could not be charged" message.
         */

        const walletTransaction =
            await walletRef.transaction(
                (currentValue) => {

                    console.log(
                        "WALLET TRANSACTION VALUE:",
                        currentValue
                    );


                    /*
                     * IMPORTANT FIX
                     *
                     * Instead of immediately aborting when
                     * Firebase gives null, use the balance we
                     * already read directly from Firebase.
                     */

                    if (
                        currentValue === null ||
                        currentValue === undefined
                    ) {

                        console.log(
                            "TRANSACTION RECEIVED NULL - USING VERIFIED BALANCE"
                        );


                        return (
                            verifiedBalance -
                            price
                        );

                    }


                    const balance =
                        Number(
                            currentValue
                        );


                    if (
                        !Number.isFinite(
                            balance
                        )
                    ) {

                        console.log(
                            "TRANSACTION BALANCE INVALID"
                        );

                        return;

                    }


                    /*
                     * Always check the actual transaction value.
                     */

                    if (
                        balance < price
                    ) {

                        console.log(
                            "TRANSACTION BALANCE INSUFFICIENT:",
                            balance
                        );

                        return;

                    }


                    return (
                        balance -
                        price
                    );

                }
            );


        console.log(
            "WALLET TRANSACTION COMMITTED:",
            walletTransaction.committed
        );


        /* =====================================================
           WALLET CHARGE FAILED
        ===================================================== */

        if (
            !walletTransaction.committed
        ) {

            console.error(
                "WALLET TRANSACTION DID NOT COMMIT"
            );


            const latestWalletSnapshot =
                await walletRef.once(
                    "value"
                );


            const latestBalance =
                Number(
                    latestWalletSnapshot.val()
                );


            console.log(
                "LATEST WALLET AFTER FAILED TRANSACTION:",
                latestBalance
            );


            await restoreInventory(
                selectedItemRef,
                uid
            );


            if (
                Number.isFinite(
                    latestBalance
                ) &&
                latestBalance < price
            ) {

                return sendResponse(
                    res,
                    400,
                    {
                        success: false,
                        message:
                            `Insufficient wallet balance. Your balance is ₦${money(latestBalance)}, but this product costs ₦${money(price)}.`
                    }
                );

            }


            return sendResponse(
                res,
                500,
                {
                    success: false,
                    message:
                        "Your wallet could not be charged. Please try again."
                }
            );

        }


        walletCharged =
            true;


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
            reservedInventory &&
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
             * Refund wallet.
             */

            const refunded =
                await refundWallet(
                    walletRef,
                    price
                );


            /*
             * Restore inventory.
             */

            await restoreInventory(
                selectedItemRef,
                uid
            );


            walletCharged =
                !refunded;


            return sendResponse(
                res,
                500,
                {
                    success: false,
                    message:
                        refunded
                            ? "Purchase could not be completed. Your wallet has been refunded."
                            : "Purchase could not be completed. Please contact support to verify your wallet balance."
                }
            );

        }


        /* =====================================================
           MARK INVENTORY SOLD
        ===================================================== */

        try {

            await selectedItemRef.update({

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
        catch (inventoryError) {

            /*
             * The order already exists and wallet has already
             * been charged. We do NOT refund here automatically
             * because the order has already been created.
             *
             * Log the problem so the inventory can be corrected
             * without risking a double refund.
             */

            console.error(
                "INVENTORY SOLD UPDATE ERROR:",
                inventoryError
            );

        }


        /* =====================================================
           PURCHASE SUCCESS
        ===================================================== */

        console.log(
            "================================="
        );

        console.log(
            "PURCHASE COMPLETED"
        );

        console.log(
            "ORDER:",
            orderId
        );

        console.log(
            "NEW BALANCE:",
            newBalance
        );

        console.log(
            "INVENTORY:",
            reservedInventoryId
        );

        console.log(
            "================================="
        );


        return sendResponse(
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


        /*
         * If something failed after inventory was reserved,
         * restore the item.
         */

        if (
            reservedInventoryId &&
            uid &&
            productId
        ) {

            try {

                const restoreRef =
                    db.ref(
                        "inventory/" +
                        productId +
                        "/" +
                        reservedInventoryId
                    );


                await restoreInventory(
                    restoreRef,
                    uid
                );

            }
            catch (restoreError) {

                console.error(
                    "FINAL INVENTORY RESTORE ERROR:",
                    restoreError
                );

            }

        }


        /*
         * Do not blindly refund here.
         *
         * If walletCharged is true, we need to know exactly
         * whether an order was created before refunding.
         *
         * This prevents accidental double refunds.
         */

        return sendResponse(
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
