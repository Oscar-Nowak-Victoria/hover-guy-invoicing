# Hover Guy quoting & invoicing

Quotes, invoices and automatic payment reminders for Hover Guy, in the Flight Deck brand.

- **Quotes**: build from the rate card, email as a branded PDF, and turn into an invoice in one click when accepted.
- **Invoices**: Australian tax invoices with ABN, GST and bank transfer details. Each one is emailed from the accounts address with the PDF attached and a copy to the accounts mailbox.
- **Clients**: search the Australian Business Register by name or ABN to fill in the company name and ABN, see whether they're registered for GST, and catch typos with the ATO's ABN check. Needs `ABR_GUID`.
- **Payments**: record bank transfers as they arrive. Part payments are supported, and paying in full stops the reminders.
- **Reminders**: sent automatically 3 days before the due date, on the due date, and at 7, 14 and 30 days overdue. Only one email goes out per run, so a client never gets a burst. After the 30-day final notice the invoice is flagged on the dashboard for you to chase personally. You can pause reminders for one invoice (disputed, or a payment date promised) or switch them off for a client.

## Safe by default

Until `SEND_MODE` is set to `microsoft` (or `smtp`), **nothing is emailed to clients**. Every quote, invoice and reminder is saved to the Emails page (and `data/outbox/*.eml`) so you can check it first.

## Run it

Needs Node 22.5 or newer, and Chromium or Chrome for the PDFs.

```sh
npm install
npm run seed     # starter rate card and an example client
npm start        # http://localhost:3000
```

Then open **Settings** and fill in your accounts email, ABN, address and bank details.

Other commands:

```sh
npm test         # tests: totals, numbering, payments, reminder rules, sending
npm run reminders  # run today's reminders once (if you'd rather use cron than the built-in daily run)
```

## Put it online (Railway)

The repo includes `railway.json` and a `Dockerfile`, so Railway builds it without any extra setup.

1. In Railway, choose **New Project → Deploy from GitHub repo** and pick this repo.
2. In the service, add a **Volume** mounted at `/app/data`. This holds the database and the outbox, and it keeps your data across deploys.
3. Under **Variables**, add `ADMIN_PASSWORD`. The app won't start without it once it's online.
4. Under **Settings → Networking**, choose **Generate Domain**. Sign in with any username and your password.

Keep it to one replica. The database is a single SQLite file on the volume.

## Connect Microsoft 365 (Office 365)

Microsoft no longer accepts mailbox passwords for sending from apps, so the app sends with the Microsoft Graph API through an app registration.

1. Sign in to [entra.microsoft.com](https://entra.microsoft.com) as an admin. Go to **Applications → App registrations → New registration**, name it `Hover Guy invoicing`, choose *this organizational directory only*, and click **Register**.
2. Copy the **Application (client) ID** and **Directory (tenant) ID** from the overview page.
3. Go to **API permissions → Add a permission → Microsoft Graph → Application permissions**, tick **Mail.Send** and add it. Then click **Grant admin consent**.
4. Go to **Certificates & secrets → New client secret**, choose 24 months, and copy the **Value** straight away. It's only shown once.
5. In Railway Variables, set `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET`. Leave `SEND_MODE` as `outbox`.
6. In the app's **Settings**, make sure the accounts email is the exact Microsoft 365 mailbox, then click **Send a test email**. The test only goes to that address.

The client secret expires, so put a reminder in your calendar to replace it before then.

## Go live

Once the test email arrives, set `SEND_MODE` to `microsoft` in Railway. The banner turns green and says **Live**, and quotes, invoices and reminders go to clients from then on.

## Where things are

| | |
|---|---|
| `server.js` | Admin screens and the daily reminder schedule |
| `src/db.js`, `src/schema.sql` | Data model. Money is stored in cents and dates as YYYY-MM-DD in your timezone |
| `src/render.js`, `public/document.css` | Quote and invoice layout from the brand guide |
| `src/emails.js` | All email wording |
| `src/actions.js` | Sending, and the reminder rules |
| `src/mailer.js` | Outbox and SMTP sending |
