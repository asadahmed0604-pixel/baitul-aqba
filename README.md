# Bait ul Aqba: Donation Tracking System

A web app for recording monthly orphan-sponsorship donations. It has two ends:

| Portal | URL | Who uses it |
|---|---|---|
| **Donor portal** | `/donor` | Donors register, submit each payment with its bank receipt, choose the orphan number(s) and month(s) it covers (including advance months), and track the status of every entry. |
| **Foundation management** | `/admin` | The foundation team reviews and verifies receipts, sees weekly/monthly reports, tracks every orphan's months, manages orphans and donors, and imports or exports data. |

It needs no database server and no packages. It runs on **Node.js 22.13 or newer** and uses Node's built-in SQLite.

## Quick start

```bash
node --version        # must be v22.13 or newer
npm start             # or: node --disable-warning=ExperimentalWarning server.js
```

Open <http://localhost:3000>. On the first run the console prints a management login
(`admin@baitulaqba.org` and a random password). Sign in at `/admin` and change the password.
To choose the first login yourself:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' npm start
```

### First things to set up (Management → Settings)
1. **Foundation accounts:** add every bank account or IBAN the foundation receives donations in.
   Receipts paid into any other account are flagged as *Not registered*. Donors see these accounts on their dashboard.
2. **Orphans:** add them under *Orphans*, or import a CSV. Each has a fixed **orphan number** (e.g. `BUA-001`) and monthly amount.
3. **Donors:** donors can register themselves, or you can add/import them and link their orphan numbers.

## How a donation entry works

1. The donor uploads a **screenshot or photo of the bank receipt**.
2. In the donor's browser, the app checks the image and reads the text on it:
   - **Clarity:** image size, blur/sharpness, and text-reading confidence. Unclear receipts are refused.
   - **Date:** only receipts dated in the **current month** are accepted. A receipt showing an older date is refused, even if the donor types a different date.
   - **Beneficiary extraction:** the beneficiary name, account number/IBAN and bank the money was sent to are pulled from the receipt, along with the amount, transaction ID and sender.
3. The donor confirms or corrects the details, picks the **orphan number(s)** and **month(s)** (current, advance or arrears), and submits.
   The amount is split evenly across every orphan × month. For example, PKR 10,000 for 1 orphan × 2 months becomes 2 month entries of 5,000.
4. The server checks everything again. It refuses duplicate receipt images and duplicate transaction IDs. It flags issues for management, such as a payment into an unregistered account, an amount or date that doesn't match the receipt, or a month that was already paid.
5. Management verifies or rejects the entry. A rejection needs a reason, which the donor sees.

Receipt reading uses [Tesseract.js](https://tesseract.projectnaptha.com/), loaded in the browser from the jsDelivr CDN.
If a donor's browser can't load it, the donor can still type the details. The entry is then marked
"automatic reading unavailable" so management checks the image by hand. Management can also press
**Re-read receipt** on any entry.

## Reports (Management)

- **Weekly report:** receipts for a month grouped by the **date on the receipt**: week 1 = 1st–7th, 2 = 8th–14th, 3 = 15th–21st, 4 = 22nd–28th, 5 = 29th–end.
  Each week shows the total, the split between current-month, advance and arrears money, the beneficiary accounts paid into, and every entry. It can be printed or saved as PDF, and exported to Excel/CSV.
- **Orphan coverage:** for any month, which orphans are paid, partly paid or unpaid, including months paid in advance earlier, with their sponsors.
- **Beneficiary accounts:** totals per account that donors paid into, taken from the receipts, with registered vs. not-registered accounts highlighted.
- **Dashboard:** this month's totals, pending reviews, weekly bars and latest entries.

## Import / Export

All files are CSV and open directly in Excel or Google Sheets.

- **Export:** donation entries (one row per receipt), month allocations (one row per orphan per month), orphans, donors, and every report. Donors can export their own history.
- **Import:** donation entries, orphans and donors. Download a template from the Import page first.
  Use **Check file** to validate without saving; rows with problems are listed by row number.
  - Entries: separate several orphans or months with `;` (e.g. `2026-09;2026-10`). Rows whose transaction ID already exists are skipped. Donors are matched by phone or email and created if new. The current-month rule does not apply to imported history.
  - Orphans: existing orphan numbers are updated and new ones are added; columns missing from the file keep their current values.
    The foundation's orphan sheet (`Code, Orphan's Name, Name, Child Phone, SP Code, Sponsor Name, Sponsor Phone, Sponsor Area`)
    imports as-is: each sponsor becomes a donor (one per phone number, SP codes kept) and is linked to their orphans.
  - Imports accept Excel `.xlsx` (first sheet) or CSV. Phone numbers are stored in one form (`+923001234567`), so donors can sign in with `0300…` or `+92 300…`.
  - Imported sponsors have no password. When one registers on the donor portal with the same phone number, they take over that record (once; logged as `donor.claim`).

## Settings you can change

Time zone (this decides what "current month" means; default `Asia/Karachi`), currency, minimum
text clarity, minimum sharpness, minimum image size, upload size limit, how many advance/arrears
months donors can select, whether donors can self-register, and whether to enforce the
current-month rules.

## Deployment notes

Step-by-step hosting guide (Render one-click blueprint, or your own server with Docker): **[DEPLOY.md](DEPLOY.md)**.


- Data is stored in `data/baitulaqba.db` and receipt images in `uploads/`. **Back up both folders.**
  Change these locations with `DATA_DIR` and `UPLOADS_DIR`.
- Other environment variables: `PORT` (default 3000), `HOST`, `SESSION_SECRET` (otherwise generated and saved in `data/`),
  `SECURE_COOKIES=1` when served over HTTPS, and `TRUST_PROXY=1` behind a hosting proxy.
- Put it behind HTTPS (e.g. Nginx or Caddy as a reverse proxy) before giving donors the link.
- Keep it running with a process manager such as `pm2`, `systemd`, or your host's Node app runner.
- Donors can add `/donor` to their phone's home screen; it opens like an app (web app manifest + icons are included).

## Development

```bash
npm test      # API and receipt-parser tests (node:test)
npm run dev   # restart on file changes
```

Project layout:

```
server.js                    entry point
src/app.js                   routes (auth, donor API, management API, reports, import/export)
src/payments.js              entry validation, receipt rules, month allocation
src/reports.js               weekly, coverage and beneficiary reports
src/db.js, auth.js, csv.js   storage, sessions/passwords, CSV
public/shared/receipt-parser.js   receipt text parsing, shared by the browser and the server
public/js/receipt-scan.js    in-browser OCR and blur detection
public/donor.html, admin.html     the two portals
```
