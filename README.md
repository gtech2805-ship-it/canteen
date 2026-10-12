# Canteen app: orders, tokens, offers and real online payment (Google Pay / UPI)

Students order on their phones. When they choose **Pay online**, the Razorpay payment window opens and
Google Pay / UPI apps appear inside it. **The order is placed only after Razorpay confirms the money was
paid.** Staff see the queue, manage the menu, stock and offers, and see sales.

There is nothing to install: the app uses only Node.js (version 18 or newer).

---

## What you need

1. A **Razorpay account** with your business details and bank account (Part 1).
2. A place to run the app 24 hours a day, called a host. This guide uses **Render** (Part 2). Railway, a VPS or
   any host that can run Node.js also works.
3. About an hour. If you are not comfortable with this, give this folder to a developer or a technical friend.
   It is a normal, small Node.js project.

---

## Part 1: Razorpay (the payment service)

1. Sign up at razorpay.com and complete the business verification (KYC). Razorpay reviews it before live
   payments are allowed. This can take a few days.
2. While you wait, use **Test Mode**. In the dashboard open *Account & Settings > API Keys > Generate Test Key*.
   You get a **Key Id** (starts with `rzp_test_`) and a **Key Secret**. Keep the secret private.
3. In *Settings > Payment Capture*, make sure payments are **captured automatically**.
4. UPI is a normal Razorpay payment method. On Android phones the payment window shows UPI apps such as
   Google Pay.

Razorpay charges a fee per payment. Check their current pricing page before you go live.

## Part 2: Put the app online on Render

1. Create a free GitHub account and upload this folder to a new repository (private is fine).
2. Create an account on render.com. Choose **New > Web Service** and connect that repository.
3. Settings:
   - **Build command:** leave empty (or `echo ok`)
   - **Start command:** `node server.js`
4. Under **Environment**, add these variables:

   | Name | Value |
   |---|---|
   | `STAFF_PIN` | A PIN only staff know (at least 4 characters) |
   | `RAZORPAY_KEY_ID` | Your Key Id (test first) |
   | `RAZORPAY_KEY_SECRET` | Your Key Secret |
   | `RAZORPAY_WEBHOOK_SECRET` | Any long random text you make up (used in Part 3) |
   | `PARCEL_FEE` | `5` |
   | `DATA_FILE` | `/var/data/canteen.json` (see the next step) |

5. **Keep your data safe.** The app stores menu and orders in one file. Free hosting plans erase files when the
   app restarts, so you would lose your data. Add a **Disk** in Render (a paid feature) mounted at `/var/data`,
   and keep `DATA_FILE=/var/data/canteen.json`. Back up that file now and then.
6. Deploy. Render gives you a web address (like `https://your-canteen.onrender.com`). Share that address with students.

## Part 3: Webhook (so an order is never lost)

If a student pays and then closes the page, the webhook still places their order.

1. In Razorpay: *Settings > Webhooks > Add new webhook*.
2. **URL:** `https://your-canteen.onrender.com/api/razorpay/webhook`
3. **Secret:** exactly the same text you used for `RAZORPAY_WEBHOOK_SECRET`.
4. **Events:** tick `payment.captured` and `order.paid`.

## Part 4: Test, then go live

1. With **test keys**, open your address on a phone, order something, choose *Pay online* and use Razorpay's
   test payment options (their test-mode guide lists test UPI IDs and cards). Check the order appears in the
   staff Queue with a token.
2. Also test: close the payment window without paying (the order must NOT appear), and pay then close the page
   (the webhook must still place it).
3. When Razorpay approves your account, generate **Live keys**, replace the two key variables in Render, and
   create the webhook again in Live mode.
4. Do one real small payment and check the money arrives.

---

## Using the app

- **Students** open the address, choose "I'm a student", pick items, choose dine in or parcel (parcel adds the
  parcel fee), pick how to pay, and get a token number and bill. They see the live queue and offers.
- **Staff** choose "Canteen staff" and enter the PIN.
  - **Queue:** mark orders prepared, then give the order when the student shows the token. Use *Check a token* to
    look up a number. Cash orders are marked paid when you hand them over.
  - **Menu:** add items with price and quantity. Items go to Sold out automatically at 0. Retype a quantity to restock.
  - **Offers:** type a % off for any item and an optional message students see.
  - **Sales:** today's sales, online and cash, and best sellers. Under **Download your data** you can download every order
    as a spreadsheet (opens in Excel or Google Sheets) and a full backup file. Do this regularly.
- **Refunds:** if staff cancel an order that was paid online, or a late payment arrives after the stock ran out,
  the order appears under **Refunds needed**. Refund it in the Razorpay dashboard (*Transactions > Payments*),
  then tap *Refund done*.
- An online order that is not paid within 15 minutes is cancelled and its stock goes back.

## Trying it on a computer first (no Razorpay needed)

1. Install Node.js from nodejs.org.
2. In this folder run these (Windows PowerShell: use `$env:NAME="value"` instead):
   `PAYMENT_MODE=mock STAFF_PIN=1234 node server.js`
3. Open http://localhost:3000. Payments are fake in this mode. **Never use mock mode online.**
4. `npm test` runs 51 automatic checks of the ordering and payment rules.

## Good to know

- The server decides all prices. A student cannot change the price from their phone.
- A payment is trusted only after Razorpay's signature is checked (or a signed webhook arrives).
- This app runs as a single copy on one server. That is right for one canteen, not for a large chain.
- Orders older than 60 days are removed automatically to keep the file small.
- Wrong PINs are blocked for 10 minutes after 6 tries.

## Install it as a phone app

Once the website is online, students and staff can install it like a normal app:

- **Android (Chrome):** open the address, tap the ⋮ menu, then **Install app** (or **Add to Home screen**).
- **iPhone (Safari):** open the address, tap Share, then **Add to Home Screen**.

It gets a Canteen icon and opens full screen. It always shows live data from your server, so everyone sees the same queue.
To get a real Play Store / APK file, paste your address into pwabuilder.com and download the Android package.
