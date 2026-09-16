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
/*
==================================================
FIREBASE ADMIN INITIALIZATION
==================================================
*/
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
/*
==================================================
HELPER
==================================================
*/
function sendJson(
    res,
    status,
    data
) {
    return res
        .status(status)
        .json(data);
}
/*
==================================================
PURCHASE API
==================================================
*/
module.exports = async function handler(
    req,
    res
) {
    /*
    ==============================================
    ONLY POST IS ALLOWED
    ==============================================
    */
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
    /*
    ==============================================
    CHECK ENVIRONMENT VARIABLES
    ==============================================
    */
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
        /*
        ==========================================
        1. GET FIREBASE ID TOKEN
        ==========================================
        */
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
            authorization.substring(
                7
            ).trim();
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
        /*
        ==========================================
        2. VERIFY USER
        ==========================================
        */
        const decodedToken =
            await adminAuth.verifyIdToken(
                idToken
            );
        const uid =
            decodedToken.uid;
        const email =
            decodedToken.email || "";
        /*
        ==========================================
        3. GET PRODUCT ID
        ==========================================
        */
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
        /*
        ==========================================
        4. LOAD PRODUCT FROM DATABASE
        ==========================================
        */
        const productRef =
            db.ref(
                "products/" +
                productId
            );
        const productSnapshot =
            await productRef.once(
                "value"
            );
        if (!productSnapshot.exists()) {
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
        /*
        ==========================================
        5. CHECK PRODUCT STATUS
        ==========================================
        */
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
        /*
        ==========================================
        6. GET PRICE FROM DATABASE
        ==========================================
        */
        const price =
            Number(
                product.price
            );
        if (
            !Number.isFinite(price) ||
            price <= 0
        ) {
            console.error(
                "Invalid product price:",
                productId,
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
        /*
        ==========================================
        7. FIND AVAILABLE INVENTORY
        ==========================================
        */
        const inventoryRef =
            db.ref(
                "inventory/" +
                productId
            );
        const inventorySnapshot =
            await inventoryRef
                .orderByChild("status")
                .equalTo("available")
                .limitToFirst(10)
                .once("value");
        const inventory =
            inventorySnapshot.val();
        if (
            !inventory ||
            typeof inventory !== "object"
        ) {
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
        /*
        ==========================================
        8. RESERVE ONE INVENTORY ITEM
        ==========================================
        */
        let reservedInventoryId =
            null;
        let reservedInventory =
            null;
        for (
            const [
                inventoryId,
                inventoryItem
            ]
            of Object.entries(
                inventory
            )
        ) {
            const itemRef =
                inventoryRef.child(
                    inventoryId
                );
            const reservation =
                await itemRef.transaction(
                    (currentItem) => {
                        if (
                            !currentItem ||
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
                reservation.committed
            ) {
                reservedInventoryId =
                    inventoryId;
                reservedInventory =
                    reservation.snapshot.val();
                break;
            }
        }
        /*
        ==========================================
        9. MAKE SURE INVENTORY WAS RESERVED
        ==========================================
        */
        if (
            !reservedInventoryId ||
            !reservedInventory
        ) {
            return sendJson(
                res,
                409,
                {
                    success: false,
                    message:
                        "This item was just purchased by another customer. Please try again."
                }
            );
        }
        const reservedItemRef =
            inventoryRef.child(
                reservedInventoryId
            );
        /*
        ==========================================
        10. DEDUCT WALLET SAFELY
        ==========================================
        */
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
        /*
        ==========================================
        11. CHECK WALLET RESULT
        ==========================================
        */
        if (
            !walletTransaction.committed
        ) {
            /*
            Release the reserved item.
            */
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
            const latestWallet =
                await walletRef.once(
                    "value"
                );
            const latestBalance =
                Number(
                    latestWallet.val()
                ) || 0;
            return sendJson(
                res,
                400,
                {
                    success: false,
                    message:
                        `Insufficient wallet balance. Your balance is ₦${latestBalance.toLocaleString("en-NG", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2
                        })}, but this product costs ₦${price.toLocaleString("en-NG", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2
                        })}.`
                }
            );
        }
        /*
        ==========================================
        12. GET NEW WALLET BALANCE
        ==========================================
        */
        const newBalance =
            Number(
                walletTransaction
                    .snapshot
                    .val()
            ) || 0;
        /*
        ==========================================
        13. CREATE ORDER
        ==========================================
        */
        const orderRef =
            db.ref(
                "orders"
            ).push();
        const orderId =
            orderRef.key;
        const deliveryDetails =
            reservedInventory.details !==
                undefined
                ? reservedInventory.details
                : "";
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
        catch (orderError) {
            console.error(
                "Order creation failed:",
                orderError
            );
            /*
            ======================================
            REFUND WALLET
            ======================================
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
            ======================================
            RELEASE INVENTORY
            ======================================
            */
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
        /*
        ==========================================
        14. MARK INVENTORY AS SOLD
        ==========================================
        */
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
        /*
        ==========================================
        15. SAFETY CHECK
        ==========================================
        */
        if (
            !soldTransaction.committed
        ) {
            console.error(
                "Inventory could not be marked sold:",
                {
                    productId,
                    inventoryId:
                        reservedInventoryId,
                    orderId,
                    uid
                }
            );
            /*
            We do not charge the customer again.
            The order has already been created.
            The inventory item remains reserved
            instead of becoming available to another
            customer.
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
        /*
        ==========================================
        16. SUCCESS
        ==========================================
        */
        console.log(
            "Purchase completed:",
            {
                uid,
                email,
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
    catch (error) {
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
