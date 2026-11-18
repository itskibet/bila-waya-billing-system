const axios = require("axios");
const moment = require("moment");
const { config } = require("./env");

const BASE_URL =
  config.mpesa.env === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

let cachedToken = null; // { value, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;

  const auth = Buffer.from(`${config.mpesa.consumerKey}:${config.mpesa.consumerSecret}`).toString("base64");
  try {
    const { data } = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 15000,
    });
    cachedToken = {
      value: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in || 3599) * 1000,
    };
    return cachedToken.value;
  } catch (error) {
    console.error("MPesa auth error:", error.response ? error.response.data : error.message);
    return null;
  }
}

function callbackUrl() {
  return `${config.mpesa.callbackBaseUrl}/mpesa/callback/${config.mpesa.callbackSecret}`;
}

// Sends the STK Push prompt to the customer's phone.
// Returns Safaricom's response data on success, or null on failure.
async function stkPush(phone, amount, transactionId) {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;

  const timestamp = moment().format("YYYYMMDDHHmmss");
  const password = Buffer.from(`${config.mpesa.shortcode}${config.mpesa.passkey}${timestamp}`).toString("base64");

  const payload = {
    BusinessShortCode: config.mpesa.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Number(amount),
    PartyA: phone,
    PartyB: config.mpesa.shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl(),
    AccountReference: "BilaWaya",
    TransactionDesc: `WiFi ${transactionId}`.slice(0, 20),
  };

  try {
    const { data } = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 20000,
    });
    if (data.ResponseCode === "0") return data;
    console.error("STK Push rejected:", data);
    return null;
  } catch (error) {
    console.error("STK Push error:", error.response ? error.response.data : error.message);
    return null;
  }
}

module.exports = { stkPush };
