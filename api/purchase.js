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
   An item is available when:

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

                status: "available",

                processingBy: null,

                processingAt: null

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


    try {

        /* =====================================================
           AUTHENTICATION
        ===================================================== */

        const authorization =
            req.headers.authorization || "";


        if (
            !authorization.startsWith("Bearer ")
        ) {

            return send(
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

            return send(
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
            await auth.verifyIdToken(token);


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

            return send(
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

            return send(
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

            return send(
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

            return send(
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

            return send(
                res,
                409,
                {
                    success: false,
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
                item && item.status,
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
                    success: false,
                    message:
                        "This product is currently out of stock."
                }
            );

        }


        /* =====================================================
           FIND + ATOMICALLY RESERVE INVENTORY
           
           IMPORTANT:
           We DO NOT fail if the first item was just taken.

           We try every available item until one is successfully
           reserved.
        ===================================================== */

        for (
            const [inventoryId]
            of entries
        ) {

            const itemRef =
                inventoryRef.child(
                    inventoryId
                );


            /*
              Read the latest version first.
            */

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
                !isAvailable(latestItem)
            ) {

                console.log(
                    "SKIPPING UNAVAILABLE ITEM:",
                    inventoryId,
                    latestItem &&
                    latestItem.status
                );

                continue;

            }


            /*
              ATOMIC RESERVATION.

              If another customer takes this item first,
              transaction will not commit and we move to
              the next inventory item.
            */

            const transaction =
                await itemRef.transaction(
                    (currentValue) => {

                        /*
                          Firebase can initially provide null
                          when transaction data is not locally
                          available.

                          Returning undefined aborts safely.
                        */

                        if (
                            currentValue === null ||
                            currentValue === undefined
                        ) {

                            return;

                        }


                        if (
                            !isAvailable(
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


            if (
                !transaction.committed
            ) {

                console.log(
                    "ITEM WAS TAKEN BY ANOTHER REQUEST:",
                    inventoryId
                );


                /*
                  DO NOT SHOW ERROR.

                  Try the next inventory item.
                */

                continue;

            }


            /*
              SUCCESSFULLY RESERVED.
            */

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

            return send(
                res,
                409,
                {
                    success: false,
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


        /*
          Read wallet first so the transaction has current data.
        */

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
                    success: false,
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
                    success: false,
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
                    success: false,
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

                    if (
                        currentValue === null ||
                        currentValue === undefined
                    ) {

                        return;

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
                        success: false,
                        message:
                            `Insufficient wallet balance. Your balance is ₦${money(latestBalance)}, but this product costs ₦${money(price)}.`
                    }
                );

            }


            return send(
                res,
                500,
                {
                    success: false,
                    message:
                        "Your wallet could not be charged. Please try again."
                }
            );

        }


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
              REFUND WALLET
            */

            try {

                await walletRef.transaction(
                    (currentValue) => {

                        if (
                            currentValue === null ||
                            currentValue === undefined
                        ) {

                            return;

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


            /*
              RESTORE INVENTORY
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
                    success: false,
                    message:
                        "Purchase could not be completed. Your wallet has been refunded."
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


        /* =====================================================
           PURCHASE SUCCESS
        ===================================================== */

        console.log(
            "PURCHASE COMPLETED:",
            orderId
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


        /*
          If inventory was reserved and something unexpected
          happened, return it to available.
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
                success: false,
                message:
                    "Unable to complete your purchase right now. Please try again."
            }
        );

    }

};
