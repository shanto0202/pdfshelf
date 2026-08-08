# Security notes

This is an MVP, not a DRM product.

## Implemented

- Passwords are stored using Node.js `crypto.scryptSync` with a unique random salt.
- Raw session tokens are never stored in the database; only SHA-256 token hashes are stored.
- New login revokes all previous active sessions for that user.
- API authorization is enforced server-side.
- PDF ownership/access is checked server-side before file delivery.
- PDF storage is outside `/public`, so files do not have public static URLs.
- Disabled accounts have active sessions revoked.
- Password reset revokes active sessions.
- File uploads verify `.pdf`, `%PDF-` signature and a 20 MB local-MVP limit.
- Static file paths are resolved against the public directory to prevent path traversal.

## Before a real public launch

1. Move the JSON database to PostgreSQL/Supabase.
2. Move PDFs to private object storage.
3. Use HTTPS only.
4. Put the API behind a production host/serverless platform.
5. Add rate limiting for login and admin routes.
6. Add audit logs for admin actions.
7. Add CSRF protection if switching to cookie-based sessions.
8. Rotate/change the default admin password immediately.
9. Add backups and recovery procedures.
10. Consider server-side PDF-to-page rendering if stronger anti-extraction protection is required.
