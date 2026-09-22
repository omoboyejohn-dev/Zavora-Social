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

    console.log("Flutterwave callback:", {
      status,
      tx_ref,
      transaction_id
    });

    if (!tx_ref) {
      return res.status(400).send(
        "Missing transaction reference."
      );
    }

    // Find the deposit using the Flutterwave transaction reference.
    const snapshot = await db
      .ref("deposits")
      .orderByChild("transactionReference")
      .equalTo(tx_ref)
      .once("value");

    if (!snapshot.exists()) {
      console.error(
        "Deposit not found for tx_ref:",
        tx_ref
      );

      return res.status(404).send(
        "Deposit not found."
      );
    }

    let depositId = null;
    let deposit = null;

    snapshot.forEach(child => {
      depositId = child.key;
      deposit = child.val();
    });

    if (!depositId || !deposit) {
      return res.status(404).send(
        "Deposit information unavailable."
      );
    }

    // If Flutterwave says the payment was not successful,
    // do not attempt to verify or credit the wallet.
    if (
      status !== "successful" ||
      !transaction_id
    ) {
      await db
        .ref(`deposits/${depositId}`)
        .update({
          status: "rejected",
          flutterwaveStatus:
            status || "cancelled",
          flutterwaveTransactionId:
            transaction_id || null,
          updatedAt: Date.now()
        });

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    // Verify the transaction directly with Flutterwave.
    const verifyResponse = await fetch(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type":
            "application/json"
        }
      }
    );

    const verifyData =
      await verifyResponse.json();

    console.log(
      "Flutterwave verification response:",
      {
        httpStatus: verifyResponse.status,
        status: verifyData?.status,
        message: verifyData?.message,
        transactionStatus:
          verifyData?.data?.status,
        transactionReference:
          verifyData?.data?.tx_ref,
        transactionCurrency:
          verifyData?.data?.currency,
        transactionAmount:
          verifyData?.data?.amount
      }
    );

    if (
      !verifyResponse.ok ||
      verifyData?.status !== "success" ||
      !verifyData?.data
    ) {
      await db
        .ref(`deposits/${depositId}`)
        .update({
          status: "rejected",
          flutterwaveStatus:
            "verification_failed",
          flutterwaveTransactionId:
            transaction_id,
          updatedAt: Date.now()
        });

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    const transaction =
      verifyData.data;

    // Verify every important payment detail.
    const verifiedSuccessfully =
      transaction.status === "successful" &&
      transaction.tx_ref ===
        deposit.transactionReference &&
      transaction.currency ===
        deposit.currency &&
      Number(transaction.amount) >=
        Number(deposit.amount);

    if (!verifiedSuccessfully) {
      console.error(
        "Flutterwave verification mismatch:",
        {
          expectedReference:
            deposit.transactionReference,
          receivedReference:
            transaction.tx_ref,
          expectedAmount:
            deposit.amount,
          receivedAmount:
            transaction.amount,
          expectedCurrency:
            deposit.currency,
          receivedCurrency:
            transaction.currency,
          receivedStatus:
            transaction.status
        }
      );

      await db
        .ref(`deposits/${depositId}`)
        .update({
          status: "rejected",
          flutterwaveStatus:
            "verification_mismatch",
          flutterwaveTransactionId:
            transaction_id,
          updatedAt: Date.now()
        });

      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=failed`
      );
    }

    // Check the latest deposit status before crediting.
    const currentDepositSnapshot =
      await db
        .ref(`deposits/${depositId}`)
        .once("value");

    const currentDeposit =
      currentDepositSnapshot.val();

    // Already credited — never credit twice.
    if (
      currentDeposit?.status ===
      "approved"
    ) {
      return res.redirect(
        `${process.env.APP_URL}/wallet.html?payment=success`
      );
    }

    /*
     * Credit the wallet using a Firebase transaction.
     * This safely handles simultaneous requests.
     */
    const walletRef = db.ref(
      `users/${deposit.uid}/walletBalance`
    );

    const walletResult =
      await walletRef.transaction(
        currentBalance => {
          const balance =
            Number(currentBalance || 0);

          return (
            balance +
            Number(deposit.amount)
          );
        }
      );

    if (!walletResult.committed) {
      throw new Error(
        "Wallet balance update was not committed."
      );
    }

    // Mark the deposit approved only after
    // the wallet transaction succeeds.
    await db
      .ref(`deposits/${depositId}`)
      .update({
        status: "approved",
        flutterwaveStatus:
          "successful",
        flutterwaveTransactionId:
          transaction_id,
        verifiedAmount:
          Number(transaction.amount),
        verifiedCurrency:
          transaction.currency,
        verifiedAt: Date.now(),
        updatedAt: Date.now()
      });

    console.log(
      "Wallet successfully credited:",
      {
        depositId,
        uid: deposit.uid,
        amount: deposit.amount,
        transactionId:
          transaction_id
      }
    );

    return res.redirect(
      `${process.env.APP_URL}/wallet.html?payment=success`
    );

  } catch (error) {
    console.error(
      "Flutterwave callback error:",
      error
    );

    return res.status(500).send(
      "Payment verification failed."
    );
  }
}
