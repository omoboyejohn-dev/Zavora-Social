import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

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
    const {
      status,
      tx_ref,
      transaction_id
    } = req.query;

    if (!tx_ref) {
      return res.status(400).send("Missing transaction reference.");
    }

    /*
     * Find the deposit created before the customer
     * was redirected to Flutterwave.
     */
    const snapshot = await db
      .ref("deposits")
      .orderByChild("transactionReference")
      .equalTo(tx_ref)
      .once("value");

    if (!snapshot.exists()) {
      return res.status(404).send("Deposit not found.");
    }

    let depositId;
    let deposit;

    snapshot.forEach(child => {
      depositId = child.key;
      deposit = child.val();
    });

    /*
     * Never credit the wallet simply because the
     * browser says the payment was successful.
     */
    if (status !== "successful" || !transaction_id) {
      await db.ref(`deposits/${depositId}`).update({
        status: "rejected",
        flutterwaveStatus: status || "cancelled",
        updatedAt: Date.now()
      });

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    /*
     * Verify the transaction directly with Flutterwave.
     */
    const verifyResponse = await fetch(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const verifyData = await verifyResponse.json();

    if (
      !verifyResponse.ok ||
      verifyData.status !== "success" ||
      !verifyData.data
    ) {
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
     * Verify the important transaction details.
     */
    const verifiedSuccessfully =
      transaction.status === "successful" &&
      transaction.tx_ref === deposit.transactionReference &&
      transaction.currency === deposit.currency &&
      Number(transaction.amount) >= Number(deposit.amount);

    if (!verifiedSuccessfully) {
      await db.ref(`deposits/${depositId}`).update({
        status: "rejected",
        flutterwaveStatus: "verification_mismatch",
        flutterwaveTransactionId: transaction_id,
        updatedAt: Date.now()
      });

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    /*
     * Prevent the same payment from being credited twice.
     */
    const currentDepositSnapshot = await db
      .ref(`deposits/${depositId}`)
      .once("value");

    const currentDeposit = currentDepositSnapshot.val();

    if (currentDeposit?.status === "approved") {
      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=success`
      );
    }

    /*
     * Update the deposit first.
     */
    await db.ref(`deposits/${depositId}`).update({
      status: "approved",
      flutterwaveStatus: "successful",
      flutterwaveTransactionId: transaction_id,
      verifiedAmount: Number(transaction.amount),
      verifiedAt: Date.now(),
      updatedAt: Date.now()
    });

    /*
     * Add the verified amount to the customer's wallet.
     */
    const walletRef = db.ref(
      `users/${deposit.uid}/walletBalance`
    );

    await walletRef.transaction(currentBalance => {
      const balance = Number(currentBalance || 0);

      return balance + Number(deposit.amount);
    });

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
