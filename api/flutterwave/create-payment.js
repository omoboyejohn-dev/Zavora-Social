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
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const {
      amount,
      uid,
      email
    } = req.body || {};

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount"
      });
    }

    if (!uid || !email) {
      return res.status(400).json({
        success: false,
        message: "Missing customer information"
      });
    }

    const numericAmount = Number(amount);

    /*
     * Generate a unique Zavora transaction reference.
     */
    const txRef =
      "ZAVORA-" +
      Date.now() +
      "-" +
      Math.random().toString(36).substring(2, 8).toUpperCase();

    /*
     * Save the deposit as pending BEFORE sending
     * the customer to Flutterwave.
     */
    const depositRef = db.ref("deposits").push();

    await depositRef.set({
      uid,
      email,
      amount: numericAmount,
      currency: "NGN",
      payment: "Flutterwave",
      transactionReference: txRef,
      status: "pending",
      createdAt: Date.now()
    });

    /*
     * Create Flutterwave Checkout payment.
     */
    const flutterwaveResponse = await fetch(
      "https://api.flutterwave.com/v3/payments",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tx_ref: txRef,
          amount: numericAmount,
          currency: "NGN",

          redirect_url:
            `${process.env.APP_URL}/api/flutterwave/callback`,

          customer: {
            email
          },

          customizations: {
            title: "Zavora Social",
            description: "Fund Zavora Social Wallet"
          },

          meta: {
            uid,
            depositId: depositRef.key
          }
        })
      }
    );

    const data = await flutterwaveResponse.json();

    if (!flutterwaveResponse.ok || data.status !== "success") {
      await depositRef.update({
        status: "rejected",
        error: data.message || "Flutterwave payment creation failed"
      });

      return res.status(400).json({
        success: false,
        message: data.message || "Unable to create payment"
      });
    }

    /*
     * Store Flutterwave's transaction information.
     */
    await depositRef.update({
      flutterwaveLink: data.data.link,
      flutterwaveStatus: "created"
    });

    return res.status(200).json({
      success: true,
      paymentLink: data.data.link,
      txRef,
      depositId: depositRef.key
    });

  } catch (error) {
    console.error("Flutterwave create payment error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
}
