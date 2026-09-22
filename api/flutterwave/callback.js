import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const requiredEnv = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_DATABASE_URL",
  "FLW_SECRET_KEY",
  "APP_URL"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = getDatabase();

export default async function handler(req, res) {
  try {
    /*
     * Flutterwave sends the customer back to this endpoint with
     * parameters such as:
     *
     * status=completed
     * tx_ref=ZAVORA-...
     * transaction_id=...
     */

    const {
      status,
      tx_ref,
      transaction_id
    } = req.query;

    console.log("Flutterwave callback received:", {
      status,
      tx_ref,
      transaction_id
    });

    /*
     * We need the transaction reference and transaction ID.
     */
    if (!tx_ref) {
      return res.status(400).send("Missing transaction reference.");
    }

    if (!transaction_id) {
      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    /*
     * Find the deposit created before the customer was
     * redirected to Flutterwave.
     */
    const snapshot = await db
      .ref("deposits")
      .orderByChild("transactionReference")
      .equalTo(tx_ref)
      .once("value");

    if (!snapshot.exists()) {
      console.error("Deposit not found for tx_ref:", tx_ref);

      return res.status(404).send("Deposit not found.");
    }

    let depositId = null;
    let deposit = null;

    snapshot.forEach((child) => {
      depositId = child.key;
      deposit = child.val();
    });

    if (!depositId || !deposit) {
      return res.status(404).send("Deposit not found.");
    }

    /*
     * If this deposit has already been approved, don't credit
     * the wallet again.
     */
    if (deposit.status === "approved") {
      console.log("Deposit already approved:", depositId);

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=success`
      );
    }

    /*
     * Flutterwave commonly returns "completed" in the callback.
     *
     * Do NOT reject a completed callback here.
     *
     * The real security check is the verification request
     * to Flutterwave's API below.
     */
    const callbackStatus = String(status || "").toLowerCase();

    if (
      callbackStatus &&
      !["completed", "successful"].includes(callbackStatus)
    ) {
      console.log(
        "Flutterwave callback was not successful:",
        callbackStatus
      );

      await db.ref(`deposits/${depositId}`).update({
        status: "rejected",
        flutterwaveStatus: callbackStatus,
        updatedAt: Date.now()
      });

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    /*
     * Verify the transaction directly with Flutterwave.
     *
     * IMPORTANT:
     * This uses the LIVE FLW_SECRET_KEY stored in Vercel.
     */
    const verifyResponse = await fetch(
      `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(
        transaction_id
      )}/verify`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const verifyData = await verifyResponse.json();

    console.log("Flutterwave verification response:", {
      httpStatus: verifyResponse.status,
      status: verifyData?.status,
      transactionStatus: verifyData?.data?.status,
      transactionId: verifyData?.data?.id,
      txRef: verifyData?.data?.tx_ref
    });

    /*
     * Flutterwave API verification itself must succeed.
     */
    if (
      !verifyResponse.ok ||
      verifyData?.status !== "success" ||
      !verifyData?.data
    ) {
      console.error(
        "Flutterwave transaction verification failed:",
        verifyData
      );

      await db.ref(`deposits/${depositId}`).update({
        status: "rejected",
        flutterwaveStatus: "verification_failed",
        flutterwaveTransactionId: transaction_id,
        updatedAt: Date.now()
      });

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    const transaction = verifyData.data;

    /*
     * Expected values from our original deposit.
     */
    const expectedReference = String(
      deposit.transactionReference || ""
    );

    const expectedAmount = Number(deposit.amount || 0);

    /*
     * Your Zavora Social wallet uses NGN.
     *
     * If the deposit already has a currency field, use it.
     * Otherwise default to NGN for older deposit records.
     */
    const expectedCurrency = String(
      deposit.currency || "NGN"
    ).toUpperCase();

    const verifiedReference = String(
      transaction.tx_ref || ""
    );

    const verifiedCurrency = String(
      transaction.currency || ""
    ).toUpperCase();

    const verifiedAmount = Number(
      transaction.amount || 0
    );

    const verifiedStatus = String(
      transaction.status || ""
    ).toLowerCase();

    /*
     * SECURITY CHECKS
     *
     * 1. Flutterwave transaction must be successful.
     * 2. Reference must match our deposit.
     * 3. Currency must match.
     * 4. Amount paid must not be lower than requested amount.
     */
    const verifiedSuccessfully =
      verifiedStatus === "successful" &&
      verifiedReference === expectedReference &&
      verifiedCurrency === expectedCurrency &&
      verifiedAmount >= expectedAmount;

    if (!verifiedSuccessfully) {
      console.error("Flutterwave verification mismatch:", {
        verifiedStatus,
        verifiedReference,
        expectedReference,
        verifiedCurrency,
        expectedCurrency,
        verifiedAmount,
        expectedAmount
      });

      await db.ref(`deposits/${depositId}`).update({
        status: "rejected",
        flutterwaveStatus: "verification_mismatch",
        flutterwaveTransactionId: transaction_id,
        verifiedAmount,
        verifiedCurrency,
        verifiedReference,
        updatedAt: Date.now()
      });

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    /*
     * Before crediting the wallet, atomically move the deposit
     * from its current state to "processing".
     *
     * This helps prevent two callback requests from both
     * crediting the same deposit.
     */
    const processingResult = await db
      .ref(`deposits/${depositId}/status`)
      .transaction((currentStatus) => {
        if (currentStatus === "approved") {
          return;
        }

        if (currentStatus === "processing") {
          return;
        }

        if (
          currentStatus === "pending" ||
          currentStatus === "created" ||
          currentStatus === "rejected" ||
          currentStatus === null
        ) {
          return "processing";
        }

        return;
      });

    /*
     * If the transaction was not committed, another callback
     * may already be processing it.
     */
    if (!processingResult.committed) {
      const latestSnapshot = await db
        .ref(`deposits/${depositId}`)
        .once("value");

      const latestDeposit = latestSnapshot.val();

      if (latestDeposit?.status === "approved") {
        return res.redirect(
          `${process.env.APP_URL}/wallet.html?payment=success`
        );
      }

      if (latestDeposit?.status === "processing") {
        return res.redirect(
          `${process.env.APP_URL}/wallet.html?payment=success`
        );
      }

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    /*
     * Record the verified Flutterwave information.
     */
    await db.ref(`deposits/${depositId}`).update({
      flutterwaveStatus: "successful",
      flutterwaveTransactionId: transaction_id,
      verifiedAmount,
      verifiedCurrency,
      verifiedReference,
      verifiedAt: Date.now(),
      updatedAt: Date.now()
    });

    /*
     * Credit the user's wallet.
     *
     * Firebase transaction guarantees that concurrent wallet
     * updates are handled safely.
     */
    if (!deposit.uid) {
      throw new Error("Deposit is missing user UID.");
    }

    const walletRef = db.ref(
      `users/${deposit.uid}/walletBalance`
    );

    await walletRef.transaction((currentBalance) => {
      const balance = Number(currentBalance || 0);

      return balance + expectedAmount;
    });

    /*
     * Wallet has now been credited successfully.
     */
    await db.ref(`deposits/${depositId}`).update({
      status: "approved",
      amountCredited: expectedAmount,
      creditedAt: Date.now(),
      updatedAt: Date.now()
    });

    console.log("Deposit approved and wallet credited:", {
      depositId,
      uid: deposit.uid,
      amount: expectedAmount,
      transactionId: transaction_id,
      txRef: tx_ref
    });

    /*
     * Send the customer back to the wallet.
     */
    return res.redirect(
      `${process.env.APP_URL}/wallet.html?payment=success`
    );

  } catch (error) {
    console.error("Flutterwave callback error:", error);

    return res.status(500).send(
      "Payment verification failed."
    );
  }
}
