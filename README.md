# PDFshelf — PDF Business MVP

A polished, mobile-friendly PDF access business starter built around your exact model:

- Manual payment outside the system
- Admin manually creates customer User ID + password
- Admin uploads PDFs and assigns purchased PDFs to customers
- One account can have **only one active session at a time**
- A new login automatically revokes the previous login
- Customers only see PDFs assigned to them
- PDFs are read inside the web reader; there is no download/share UI
- Reader displays an account-specific watermark overlay
- PWA manifest/service worker included for “Add to Home Screen” behavior

## 1. Run it

Requirements: Node.js 20 or newer.

```bash
cd pdf-business
npm start
```

Then open:

```text
http://localhost:3000
```

No `npm install` is required. The project uses only Node.js built-in modules.

## 2. Default test accounts

### Admin
- User ID: `admin`
- Password: `Admin@12345`

### Demo customer
- User ID: `demo`
- Password: `Demo@12345`

The demo customer already has access to `Welcome Guide.pdf`.

**Before real use, sign in as admin and reset the admin password from Admin → Users.**

## 3. How the single-active-session rule works

When the same account logs in again:

1. The server verifies the User ID and password.
2. Every previous active session belonging to that account is revoked.
3. A fresh random session token is created.
4. The new device/browser is allowed in.
5. The old browser checks `/api/me` every 5 seconds. Once it sees that the session is revoked, it signs out.

This is **not permanent device locking**. Device A can log in, then Device B can log in and kick A out, then A can log in again and kick B out.

## 4. Admin workflow

1. Customer pays you manually (bKash/Nagad/etc.) outside the app.
2. Open **Admin → Users → New user**.
3. Enter the customer's name, chosen User ID and password.
4. Open **Admin → PDFs → Upload PDF**.
5. Open **Admin → Access**.
6. Select the customer and purchased PDF, then click **Grant PDF access**.
7. Give the User ID/password to the customer.

## 5. Project structure

```text
pdf-business/
├── server.js                 # Node HTTP/API server, auth, sessions, PDF access
├── package.json
├── README.md
├── SECURITY.md
├── data/
│   └── db.json               # Auto-created local JSON database
├── storage/
│   └── pdfs/                 # Private local PDF files (not web-served directly)
└── public/
    ├── index.html            # Login
    ├── library.html          # Customer library
    ├── admin.html            # Admin control center
    ├── reader.html           # In-browser PDF reader
    ├── manifest.webmanifest
    ├── sw.js
    └── assets/
        ├── app.css
        ├── common.js
        ├── login.js
        ├── library.js
        ├── admin.js
        ├── reader.js
        └── icon.svg
```

## 6. Important: “non-downloadable PDF” limitation

A browser must receive document bytes to render a PDF. Therefore no normal website can guarantee that a technically skilled user will never extract content.

This MVP intentionally improves casual protection by:

- keeping PDFs outside the public web folder;
- requiring an active authenticated session for `/api/pdfs/:id/file`;
- checking user-to-PDF assignment server-side;
- serving with `Cache-Control: no-store`;
- hiding normal reader toolbar controls where the browser supports it;
- blocking common save/print shortcuts in the surrounding reader UI;
- adding a visible per-account watermark;
- enforcing one active session.

For stronger commercial DRM later, convert PDFs to server-rendered page images/tiles or use a native Android application with stronger platform controls.

## 7. Local MVP vs public hosting

This zip is deliberately **fully runnable locally without any third-party account**. It stores data in `data/db.json` and PDFs on the local filesystem.

Do **not** upload this exact persistence layer to ordinary static Netlify hosting and expect uploads/database changes to persist. For a public production version, keep the same UI and API contract but migrate:

- `data/db.json` → Supabase/PostgreSQL
- `storage/pdfs` → private Supabase Storage / S3-compatible private bucket
- `server.js` API routes → Netlify Functions or another persistent Node host

The front-end is already separated from the API enough to make that migration straightforward.

## 8. Backups

For this local version, back up these two locations:

```text
data/db.json
storage/pdfs/
```

They contain your customer/access data and PDFs.
