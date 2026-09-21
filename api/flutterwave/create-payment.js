import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
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

const adminAuth = getAuth();
const db = getDatabase();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    /*
     * Get Firebase ID token from the browser.
     */
    const authorization =
      req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const idToken =
      authorization.substring(7);

    /*
     * Verify the Firebase customer.
     */
    const decodedToken =
      await adminAuth.verifyIdToken(idToken);

    const uid =
      decodedToken.uid;

    const email =
      decodedToken.email || "";

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Your account does not have an email address."
      });
    }

    const amount =
      Number(req.body?.amount);

    /*
     * Validate amount.
     */
    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid amount."
      });
    }

    /*
     * Optional minimum deposit.
     *
     * Change this later if you want.
     */
    if (amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimum deposit is ₦100."
      });
    }

    /*
     * Unique Zavora transaction reference.
     */
    const txRef =
      "ZAVORA-" +
      Date.now() +
      "-" +
      Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();

    /*
     * Create pending deposit.
     */
    const depositRef =
      db.ref("deposits").push();

    await depositRef.set({
      uid,
      email,

      amount,

      currency: "NGN",

      payment: "Flutterwave",

      transactionReference:
        txRef,

      status: "pending",

      createdAt:
        Date.now()
    });

    /*
     * Create Flutterwave Checkout.
     */
    const flutterwaveResponse =
      await fetch(
        "https://api.flutterwave.com/v3/payments",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${process.env.FLW_SECRET_KEY}`,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            tx_ref:
              txRef,

            amount,

            currency:
              "NGN",

            redirect_url:
              `${process.env.APP_URL}/api/flutterwave/callback`,

            customer: {
              email
            },

            customizations: {
              title:
                "Zavora Social",

              description:
                "Fund your Zavora Social wallet"
            },

            meta: {
              uid,
              depositId:
                depositRef.key
            }

          })
        }
      );

    const data =
      await flutterwaveResponse.json();

    if (
      !flutterwaveResponse.ok ||
      data.status !== "success" ||
      !data.data?.link
    ) {

      await depositRef.update({
        status: "rejected",

        error:
          data.message ||
          "Unable to create Flutterwave payment",

        updatedAt:
          Date.now()
      });

      return res.status(400).json({
        success: false,

        message:
          data.message ||
          "Unable to create payment."
      });
    }

    /*
     * Save Flutterwave checkout information.
     */
    await depositRef.update({

      flutterwaveLink:
        data.data.link,

      flutterwaveStatus:
        "created",

      updatedAt:
        Date.now()

    });

    return res.status(200).json({

      success: true,

      paymentLink:
        data.data.link,

      txRef,

      depositId:
        depositRef.key

    });

  } catch (error) {

    console.error(
      "Create payment error:",
      error
    );

    return res.status(500).json({

      success: false,

      message:
        "Unable to create payment."
    });
  }
}
