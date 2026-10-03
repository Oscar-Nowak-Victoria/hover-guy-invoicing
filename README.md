# Hover Guy quoting & invoicing

Quotes, invoices and automatic payment reminders for Hover Guy, in the Flight Deck brand.

- **Quotes**: build from the rate card, email as a branded PDF, and turn into an invoice in one click when accepted.
- **Invoices**: Australian tax invoices with ABN, GST and bank transfer details. Each one is emailed from the accounts address with the PDF attached and a copy to the accounts mailbox.
- **Payments**: record bank transfers as they arrive. Part payments are supported, and paying in full stops the reminders.
- **Reminders**: sent automatically 3 days before the due date, on the due date, and at 7, 14 and 30 days overdue. Only one email goes out per run, so a client never gets a burst. After the 30-day final notice the invoice is flagged on the dashboard for you to chase personally. You can pause reminders for one invoice (disputed, or a payment date promised) or switch them off for a client.

## Safe by default

Until `SEND_MODE=smtp` is set, **nothing is emailed**. Every quote, invoice and reminder is saved to the Emails page (and `data/outbox/*.eml`) so you can check it first.

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

## Put it online

Use the Dockerfile with any host that offers a persistent disk (Railway, Fly.io or Render, for example). Mount the disk at `/app/data`, because that's where the database lives, and set `ADMIN_PASSWORD`. Without a password, the app only listens on the computer it's running on.

## Go live

1. Fill in Settings, then send yourself a test quote and invoice by using your own address as a client's email.
2. Set the SMTP details for the accounts mailbox (see `.env.example`) and `SEND_MODE=smtp`.
3. Restart. The banner turns green and says **Live**.

## Where things are

| | |
|---|---|
| `server.js` | Admin screens and the daily reminder schedule |
| `src/db.js`, `src/schema.sql` | Data model. Money is stored in cents and dates as YYYY-MM-DD in your timezone |
| `src/render.js`, `public/document.css` | Quote and invoice layout from the brand guide |
| `src/emails.js` | All email wording |
| `src/actions.js` | Sending, and the reminder rules |
| `src/mailer.js` | Outbox and SMTP sending |
