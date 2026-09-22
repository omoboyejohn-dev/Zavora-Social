import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "")
        .replace(/\\n/g, "\n")
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
     * ---------------------------------------------------------
     * CHECK SERVER CONFIGURATION
     * ---------------------------------------------------------
     */

    const requiredFirebaseEnv = [
      "FIREBASE_PROJECT_ID",
      "FIREBASE_CLIENT_EMAIL",
      "FIREBASE_PRIVATE_KEY",
      "FIREBASE_DATABASE_URL"
    ];

    for (const variable of requiredFirebaseEnv) {
      if (!process.env[variable]) {
        console.error(
          `Missing Firebase environment variable: ${variable}`
        );

        return res.status(500).json({
          success: false,
          message: "Firebase server configuration is incomplete."
        });
      }
    }

    if (!process.env.FLW_SECRET_KEY) {
      console.error("FLW_SECRET_KEY is missing.");

      return res.status(500).json({
        success: false,
        message: "Flutterwave server configuration is incomplete."
      });
    }

    if (!process.env.APP_URL) {
      console.error("APP_URL is missing.");

      return res.status(500).json({
        success: false,
        message: "Application URL configuration is incomplete."
      });
    }

    /*
     * ---------------------------------------------------------
     * AUTHENTICATE USER
     * ---------------------------------------------------------
     */

    const authorization =
      req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required."
      });
    }

    const idToken =
      authorization.substring(7);

    const decodedToken =
      await adminAuth.verifyIdToken(idToken);

    const uid =
      decodedToken.uid;

    const email =
      decodedToken.email || "";

    if (!email) {
      return res.status(400).json({
        success: false,
        message:
          "Your account does not have an email address."
      });
    }

    /*
     * ---------------------------------------------------------
     * VALIDATE AMOUNT
     * ---------------------------------------------------------
     */

    const amount =
      Number(req.body?.amount);

    if (!Number.isFinite(amount)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid amount."
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid amount."
      });
    }

    if (amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimum deposit is ₦100."
      });
    }

    /*
     * Keep the amount to two decimal places.
     */
    const paymentAmount =
      Math.round(amount * 100) / 100;

    /*
     * ---------------------------------------------------------
     * CREATE UNIQUE TRANSACTION REFERENCE
     * ---------------------------------------------------------
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
     * ---------------------------------------------------------
     * CREATE FIREBASE DEPOSIT
     * ---------------------------------------------------------
     */

    const depositRef =
      db.ref("deposits").push();

    const depositId =
      depositRef.key;

    await depositRef.set({
      uid,
      email,
      amount: paymentAmount,
      currency: "NGN",
      payment: "Flutterwave",
      transactionReference: txRef,
      status: "pending",
      createdAt: Date.now()
    });

    /*
     * ---------------------------------------------------------
     * CREATE FLUTTERWAVE CHECKOUT
     * ---------------------------------------------------------
     */

    const callbackUrl =
      `${process.env.APP_URL}/api/flutterwave/callback`;

    const flutterwavePayload = {
      tx_ref: txRef,
      amount: paymentAmount,
      currency: "NGN",

      redirect_url: callbackUrl,

      customer: {
        email
      },

      customizations: {
        title: "Zavora Social",
        description:
          "Fund your Zavora Social wallet"
      },

      meta: {
        uid,
        depositId
      }
    };

    /*
     * Never log the secret key.
     */
    console.log(
      "Creating Flutterwave payment:",
      {
        txRef,
        amount: paymentAmount,
        currency: "NGN",
        callbackUrl,
        depositId,
        email
      }
    );

    const flutterwaveResponse =
      await fetch(
        "https://api.flutterwave.com/v3/payments",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${process.env.FLW_SECRET_KEY}`,

            "Content-Type":
              "application/json",

            Accept:
              "application/json"
          },

          body:
            JSON.stringify(
              flutterwavePayload
            )
        }
      );

    /*
     * ---------------------------------------------------------
     * READ FLUTTERWAVE RESPONSE
     * ---------------------------------------------------------
     */

    const responseText =
      await flutterwaveResponse.text();

    let flutterwaveData;

    try {
      flutterwaveData =
        JSON.parse(responseText);
    } catch {
      console.error(
        "Flutterwave returned a non-JSON response:",
        {
          httpStatus:
            flutterwaveResponse.status,

          response:
            responseText.substring(0, 1000)
        }
      );

      await depositRef.update({
        status: "rejected",
        error:
          "Flutterwave returned an invalid response.",
        updatedAt: Date.now()
      });

      return res.status(502).json({
        success: false,
        message:
          "Flutterwave returned an invalid response."
      });
    }

    /*
     * IMPORTANT:
     * Log Flutterwave's response WITHOUT exposing
     * our secret key.
     */
    console.log(
      "Flutterwave create-payment response:",
      {
        httpStatus:
          flutterwaveResponse.status,

        status:
          flutterwaveData?.status,

        message:
          flutterwaveData?.message,

        hasPaymentLink:
          Boolean(
            flutterwaveData?.data?.link
          )
      }
    );

    /*
     * ---------------------------------------------------------
     * HANDLE FLUTTERWAVE ERROR
     * ---------------------------------------------------------
     */

    if (
      !flutterwaveResponse.ok ||
      flutterwaveData?.status !== "success" ||
      !flutterwaveData?.data?.link
    ) {
      const flutterwaveError =
        flutterwaveData?.message ||
        "Unable to create Flutterwave payment.";

      console.error(
        "Flutterwave payment creation failed:",
        {
          httpStatus:
            flutterwaveResponse.status,

          status:
            flutterwaveData?.status,

          message:
            flutterwaveError,

          response:
            flutterwaveData
        }
      );

      await depositRef.update({
        status: "rejected",
        flutterwaveStatus:
          "creation_failed",
        error:
          flutterwaveError,
        updatedAt:
          Date.now()
      });

      return res.status(400).json({
        success: false,
        message:
          flutterwaveError
      });
    }

    /*
     * ---------------------------------------------------------
     * PAYMENT CREATED SUCCESSFULLY
     * ---------------------------------------------------------
     */

    const paymentLink =
      flutterwaveData.data.link;

    await depositRef.update({
      flutterwaveLink:
        paymentLink,

      flutterwaveStatus:
        "created",

      updatedAt:
        Date.now()
    });

    console.log(
      "Flutterwave payment created successfully:",
      {
        txRef,
        depositId,
        amount: paymentAmount
      }
    );

    /*
     * ---------------------------------------------------------
     * SEND PAYMENT LINK TO FRONTEND
     * ---------------------------------------------------------
     */

    return res.status(200).json({
      success: true,

      paymentLink,

      txRef,

      depositId
    });

  } catch (error) {
    console.error(
      "Create payment error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Unable to create payment."
    });
  }
}
