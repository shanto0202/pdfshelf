'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { createClient } = require('@supabase/supabase-js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');


const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 168);
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'pdfs';

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);


function nowIso() {
  return new Date().toISOString();
}

function futureIso(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function safeText(value, max = 240) {
  return String(value || '').trim().slice(0, max);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, keyHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !keyHex) return false;
    const derived = crypto.scryptSync(password, salt, 64);
    const storedKey = Buffer.from(keyHex, 'hex');
    if (storedKey.length !== derived.length) return false;
    return crypto.timingSafeEqual(storedKey, derived);
  } catch {
    return false;
  }
}


function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function noContent(res, status = 204) {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}

async function readJson(req, limit = MAX_JSON_BYTES) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Invalid JSON');
    err.statusCode = 400;
    throw err;
  }
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

async function authenticate(req) {
  const token = getBearerToken(req);

  if (!token) return null;

  const tokenHash = sha256(token);

  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select(
      'id, user_id, token_hash, user_agent, created_at, expires_at, revoked_at'
    )
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (sessionError || !session) {
    return null;
  }

  if (session.revoked_at) {
    return null;
  }

  if (
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    return null;
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select(
      'id, name, username, password_hash, role, status, created_at'
    )
    .eq('id', session.user_id)
    .maybeSingle();

  if (userError || !user) {
    return null;
  }

  if (user.status !== 'ACTIVE') {
    return null;
  }

  return {
    user,
    session,
    token
  };
}

async function requireAuth(req, res) {
  const auth = await authenticate(req);
  if (!auth) {
    json(res, 401, { error: 'SESSION_INVALID', message: 'Your session is no longer active. Please sign in again.' });
    return null;
  }
  return auth;
}

async function requireAdmin(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (auth.user.role !== 'ADMIN') {
    json(res, 403, { error: 'ADMIN_REQUIRED', message: 'Admin access is required.' });
    return null;
  }
  return auth;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.created_at || user.createdAt
  };
}


async function handleLogin(req, res) {
  const body = await readJson(req, 64 * 1024);

  const username = normalizeUsername(body.username);
  const password = String(body.password || '');

  if (!username || !password) {
    return json(res, 400, {
      error: 'MISSING_CREDENTIALS',
      message: 'User ID and password are required.'
    });
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select(
      'id, name, username, password_hash, role, status, created_at'
    )
    .eq('username', username)
    .maybeSingle();

  if (userError) {
    console.error(userError);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not process login.'
    });
  }

  if (
    !user ||
    !verifyPassword(password, user.password_hash)
  ) {
    return json(res, 401, {
      error: 'INVALID_LOGIN',
      message: 'The User ID or password is incorrect.'
    });
  }

  if (user.status !== 'ACTIVE') {
    return json(res, 403, {
      error: 'ACCOUNT_DISABLED',
      message: 'This account is disabled.'
    });
  }

  const revokedAt = nowIso();

  // Revoke previous active sessions
  const { error: revokeError } = await supabase
    .from('sessions')
    .update({
      revoked_at: revokedAt
    })
    .eq('user_id', user.id)
    .is('revoked_at', null);

  if (revokeError) {
    console.error(revokeError);

    return json(res, 500, {
      error: 'SESSION_ERROR',
      message: 'Could not replace previous session.'
    });
  }

  const token = crypto
    .randomBytes(32)
    .toString('base64url');

  const tokenHash = sha256(token);

  const userAgent = safeText(
    req.headers['user-agent'] || 'Unknown browser',
    300
  );

  const expiresAt = futureIso(
    SESSION_TTL_HOURS
  );

  const { error: insertError } = await supabase
    .from('sessions')
    .insert({
      user_id: user.id,
      token_hash: tokenHash,
      user_agent: userAgent,
      expires_at: expiresAt,
      revoked_at: null
    });

  if (insertError) {
    console.error(insertError);

    return json(res, 500, {
      error: 'SESSION_ERROR',
      message: 'Could not create login session.'
    });
  }

  return json(res, 200, {
    token,
    user: publicUser(user),
    expiresInHours: SESSION_TTL_HOURS
  });
}

async function handleLogout(req, res) {
  const auth = await requireAuth(req, res);

  if (!auth) return;

  const { error } = await supabase
    .from('sessions')
    .update({
      revoked_at: nowIso()
    })
    .eq('id', auth.session.id);

  if (error) {
    console.error(error);

    return json(res, 500, {
      error: 'SESSION_ERROR',
      message: 'Could not log out.'
    });
  }

  noContent(res);
}

async function handleMe(req, res) {
  const auth = await requireAuth(req, res);

  if (!auth) return;

  json(res, 200, {
    user: publicUser(auth.user),

    session: {
      id: auth.session.id,
      expiresAt: auth.session.expires_at
    }
  });
}

async function handleLibrary(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    let pdfs = [];

    if (auth.user.role === 'ADMIN') {
      const { data, error } = await supabase
        .from('pdfs')
        .select('id, title, description, size_bytes, created_at')
        .eq('status', 'ACTIVE')
        .order('created_at', { ascending: false });

      if (error) throw error;

      pdfs = data || [];
    } else {
      const { data: grants, error: grantError } = await supabase
        .from('grants')
        .select('pdf_id')
        .eq('user_id', auth.user.id)
        .eq('status', 'ACTIVE');

      if (grantError) throw grantError;

      const pdfIds = (grants || []).map((g) => g.pdf_id);

      if (pdfIds.length) {
        const { data, error } = await supabase
          .from('pdfs')
          .select('id, title, description, size_bytes, created_at')
          .in('id', pdfIds)
          .eq('status', 'ACTIVE')
          .order('created_at', { ascending: false });

        if (error) throw error;

        pdfs = data || [];
      }
    }

    json(res, 200, {
      items: pdfs.map((pdf) => ({
        id: pdf.id,
        title: pdf.title,
        description: pdf.description,
        size: Number(pdf.size_bytes || 0),
        createdAt: pdf.created_at
      }))
    });

  } catch (error) {
    console.error('Library error:', error);

    json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not load your library.'
    });
  }
}

async function canReadPdf(user, pdfId) {
  if (user.role === 'ADMIN') {
    return true;
  }

  const { data, error } = await supabase
    .from('grants')
    .select('id')
    .eq('user_id', user.id)
    .eq('pdf_id', pdfId)
    .eq('status', 'ACTIVE')
    .maybeSingle();

  if (error) {
    console.error('PDF permission check error:', error);
    return false;
  }

  return Boolean(data);
}

async function streamPdf(req, res, pdfId) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { data: pdf, error: pdfError } = await supabase
      .from('pdfs')
      .select(
        'id, original_name, stored_name, size_bytes, status'
      )
      .eq('id', pdfId)
      .eq('status', 'ACTIVE')
      .maybeSingle();

    if (pdfError) throw pdfError;

    if (!pdf) {
      return json(res, 404, {
        error: 'PDF_NOT_FOUND',
        message: 'PDF not found.'
      });
    }

    const allowed = await canReadPdf(
      auth.user,
      pdfId
    );

    if (!allowed) {
      return json(res, 403, {
        error: 'PDF_ACCESS_DENIED',
        message: 'You do not have access to this PDF.'
      });
    }

    const { data: fileBlob, error: downloadError } =
      await supabase
        .storage
        .from(SUPABASE_BUCKET)
        .download(pdf.stored_name);

    if (downloadError) {
      console.error(downloadError);

      return json(res, 404, {
        error: 'FILE_MISSING',
        message: 'The PDF file could not be loaded.'
      });
    }

    const arrayBuffer = await fileBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const fileName = String(
      pdf.original_name || 'document.pdf'
    ).replace(/"/g, '');

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        `inline; filename="${fileName}"`,
      'Content-Length': buffer.length,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff'
    });

    res.end(buffer);

  } catch (error) {
    console.error('PDF stream error:', error);

    json(res, 500, {
      error: 'PDF_LOAD_ERROR',
      message: 'Could not load this PDF.'
    });
  }
}

async function handleAdminDashboard(req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  try {
    const [
      usersResult,
      pdfsResult,
      grantsResult,
      sessionsResult
    ] = await Promise.all([
      supabase
        .from('users')
        .select('id, name, username, role, status, created_at'),

      supabase
        .from('pdfs')
        .select(
          'id, title, description, original_name, stored_name, size_bytes, status, created_at'
        ),

      supabase
        .from('grants')
        .select('id, user_id, pdf_id, status, granted_at'),

      supabase
        .from('sessions')
        .select('id, user_id, expires_at, revoked_at')
    ]);

    if (usersResult.error) throw usersResult.error;
    if (pdfsResult.error) throw pdfsResult.error;
    if (grantsResult.error) throw grantsResult.error;
    if (sessionsResult.error) throw sessionsResult.error;

    const users = usersResult.data || [];
    const pdfs = pdfsResult.data || [];
    const grants = grantsResult.data || [];
    const sessions = sessionsResult.data || [];

    const now = Date.now();

    const activeSessionCountFor = (userId) => {
      return sessions.filter((session) => {
        return (
          session.user_id === userId &&
          !session.revoked_at &&
          new Date(session.expires_at).getTime() > now
        );
      }).length;
    };

    json(res, 200, {
      summary: {
        users: users.filter((u) => u.role === 'USER').length,

        activeUsers: users.filter(
          (u) => u.role === 'USER' && u.status === 'ACTIVE'
        ).length,

        pdfs: pdfs.filter(
          (p) => p.status === 'ACTIVE'
        ).length,

        grants: grants.filter(
          (g) => g.status === 'ACTIVE'
        ).length
      },

      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        role: u.role,
        status: u.status,
        createdAt: u.created_at,
        activeSessions: activeSessionCountFor(u.id)
      })),

      pdfs: pdfs.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        originalName: p.original_name,
        storedName: p.stored_name,
        size: p.size_bytes,
        status: p.status,
        createdAt: p.created_at,

        accessCount: grants.filter(
          (g) =>
            g.pdf_id === p.id &&
            g.status === 'ACTIVE'
        ).length
      })),

      grants: grants
        .filter((g) => g.status === 'ACTIVE')
        .map((g) => ({
          id: g.id,
          userId: g.user_id,
          pdfId: g.pdf_id,
          status: g.status,
          grantedAt: g.granted_at
        }))
    });

  } catch (error) {
    console.error('Supabase dashboard error:', error);

    json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not load dashboard data.'
    });
  }
}

async function handleCreateUser(req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = await readJson(req, 128 * 1024);

  const name = safeText(body.name, 120);
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');

  if (name.length < 2) {
    return json(res, 400, {
      error: 'INVALID_NAME',
      message: 'Name must be at least 2 characters.'
    });
  }

  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    return json(res, 400, {
      error: 'INVALID_USERNAME',
      message:
        'User ID must be 3-40 characters and use letters, numbers, dot, underscore or hyphen.'
    });
  }

  if (password.length < 8) {
    return json(res, 400, {
      error: 'WEAK_PASSWORD',
      message: 'Password must be at least 8 characters.'
    });
  }

  // Check Supabase first
  const { data: existingUser, error: checkError } = await supabase
    .from('users')
    .select('id')
    .eq('username', username)
    .maybeSingle();

  if (checkError) {
    console.error(checkError);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not check existing user.'
    });
  }

  if (existingUser) {
    return json(res, 409, {
      error: 'USERNAME_TAKEN',
      message: 'That User ID already exists.'
    });
  }

  const { data: newUser, error: insertError } = await supabase
    .from('users')
    .insert({
      name,
      username,
      password_hash: hashPassword(password),
      role: 'USER',
      status: 'ACTIVE'
    })
    .select('id, name, username, role, status, created_at')
    .single();

  if (insertError) {
    console.error(insertError);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not create user.'
    });
  }

  json(res, 201, {
    user: {
      id: newUser.id,
      name: newUser.name,
      username: newUser.username,
      role: newUser.role,
      status: newUser.status,
      createdAt: newUser.created_at
    }
  });
}

async function handleUserStatus(
  req,
  res,
  userId
) {
  const auth = await requireAdmin(
    req,
    res
  );

  if (!auth) return;

  const body = await readJson(
    req,
    64 * 1024
  );

  const status = String(
    body.status || ''
  ).toUpperCase();

  if (
    !['ACTIVE', 'DISABLED']
      .includes(status)
  ) {
    return json(res, 400, {
      error: 'INVALID_STATUS',
      message:
        'Status must be ACTIVE or DISABLED.'
    });
  }

  const {
    data: user,
    error
  } = await supabase
    .from('users')
    .update({ status })
    .eq('id', userId)
    .select(
      'id, name, username, role, status, created_at'
    )
    .maybeSingle();

  if (error) {
    console.error(error);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not update user.'
    });
  }

  if (!user) {
    return json(res, 404, {
      error: 'USER_NOT_FOUND',
      message: 'User not found.'
    });
  }

  if (status !== 'ACTIVE') {
    await supabase
      .from('sessions')
      .update({
        revoked_at: nowIso()
      })
      .eq('user_id', userId)
      .is('revoked_at', null);
  }

  json(res, 200, {
    user: publicUser(user)
  });
}

async function handleResetPassword(
  req,
  res,
  userId
) {
  const auth = await requireAdmin(
    req,
    res
  );

  if (!auth) return;

  const body = await readJson(
    req,
    64 * 1024
  );

  const password = String(
    body.password || ''
  );

  if (password.length < 8) {
    return json(res, 400, {
      error: 'WEAK_PASSWORD',
      message:
        'Password must be at least 8 characters.'
    });
  }

  const {
    data: user,
    error
  } = await supabase
    .from('users')
    .update({
      password_hash:
        hashPassword(password)
    })
    .eq('id', userId)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error(error);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message:
        'Could not reset password.'
    });
  }

  if (!user) {
    return json(res, 404, {
      error: 'USER_NOT_FOUND',
      message: 'User not found.'
    });
  }

  await supabase
    .from('sessions')
    .update({
      revoked_at: nowIso()
    })
    .eq('user_id', userId)
    .is('revoked_at', null);

  json(res, 200, {
    message:
      'Password updated. Existing sessions were signed out.'
  });
}

async function handleUploadPdf(req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = await readJson(
    req,
    MAX_JSON_BYTES
  );

  const title = safeText(
    body.title,
    160
  );

  const description = safeText(
    body.description,
    800
  );

  const originalName =
    safeText(body.fileName, 180) ||
    'document.pdf';

  const dataBase64 = String(
    body.dataBase64 || ''
  );

  if (title.length < 2) {
    return json(res, 400, {
      error: 'INVALID_TITLE',
      message: 'PDF title is required.'
    });
  }

  if (
    !originalName
      .toLowerCase()
      .endsWith('.pdf')
  ) {
    return json(res, 400, {
      error: 'PDF_ONLY',
      message: 'Only PDF files are allowed.'
    });
  }

  if (!dataBase64) {
    return json(res, 400, {
      error: 'FILE_REQUIRED',
      message: 'Choose a PDF file.'
    });
  }

  let buffer;

  try {
    buffer = Buffer.from(
      dataBase64,
      'base64'
    );
  } catch {
    return json(res, 400, {
      error: 'INVALID_FILE',
      message: 'The PDF could not be decoded.'
    });
  }

  if (!buffer.length) {
    return json(res, 400, {
      error: 'INVALID_FILE',
      message: 'The PDF is empty.'
    });
  }

  if (
    buffer.subarray(0, 5)
      .toString('ascii') !== '%PDF-'
  ) {
    return json(res, 400, {
      error: 'INVALID_PDF',
      message: 'The selected file is not a valid PDF.'
    });
  }

  const id = crypto.randomUUID();

  const storedName =
    `${id}.pdf`;

  // Upload PDF to PRIVATE Supabase bucket
  const {
    error: storageError
  } = await supabase
    .storage
    .from(SUPABASE_BUCKET)
    .upload(
      storedName,
      buffer,
      {
        contentType: 'application/pdf',
        cacheControl: '0',
        upsert: false
      }
    );

  if (storageError) {
    console.error(
      'PDF storage upload error:',
      storageError
    );

    return json(res, 500, {
      error: 'STORAGE_ERROR',
      message: 'Could not upload PDF.'
    });
  }

  // Save metadata
  const {
    data: pdf,
    error: databaseError
  } = await supabase
    .from('pdfs')
    .insert({
      id,
      title,
      description,
      original_name: originalName,
      stored_name: storedName,
      size_bytes: buffer.length,
      status: 'ACTIVE'
    })
    .select(
      'id, title, description, original_name, stored_name, size_bytes, status, created_at'
    )
    .single();

  // If DB insert fails, remove uploaded file
  if (databaseError) {
    console.error(
      'PDF database error:',
      databaseError
    );

    await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .remove([storedName]);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not save PDF information.'
    });
  }

  json(res, 201, {
    pdf: {
      id: pdf.id,
      title: pdf.title,
      description: pdf.description,
      originalName:
        pdf.original_name,
      storedName:
        pdf.stored_name,
      size:
        Number(pdf.size_bytes),
      status:
        pdf.status,
      createdAt:
        pdf.created_at
    }
  });
}

async function handleDeletePdf(
  req,
  res,
  pdfId
) {
  const auth = await requireAdmin(
    req,
    res
  );

  if (!auth) return;

  const {
    data: pdf,
    error: findError
  } = await supabase
    .from('pdfs')
    .select(
      'id, stored_name'
    )
    .eq('id', pdfId)
    .maybeSingle();

  if (findError) {
    console.error(findError);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not delete PDF.'
    });
  }

  if (!pdf) {
    return json(res, 404, {
      error: 'PDF_NOT_FOUND',
      message: 'PDF not found.'
    });
  }

  const { error: pdfUpdateError } =
    await supabase
      .from('pdfs')
      .update({
        status: 'DELETED'
      })
      .eq('id', pdfId);

  if (pdfUpdateError) {
    console.error(pdfUpdateError);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not delete PDF.'
    });
  }

  const { error: grantError } =
    await supabase
      .from('grants')
      .update({
        status: 'REVOKED'
      })
      .eq('pdf_id', pdfId)
      .eq('status', 'ACTIVE');

  if (grantError) {
    console.error(
      'Grant revoke error:',
      grantError
    );
  }

  const { error: storageError } =
    await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .remove([
        pdf.stored_name
      ]);

  if (storageError) {
    console.warn(
      'Storage cleanup failed:',
      storageError.message
    );
  }

  noContent(res);
}

async function handleGrant(req, res) {
  const auth = await requireAdmin(
    req,
    res
  );

  if (!auth) return;

  const body = await readJson(
    req,
    64 * 1024
  );

  const userId = String(
    body.userId || ''
  );

  const pdfId = String(
    body.pdfId || ''
  );

  const {
    data: user,
    error: userError
  } = await supabase
    .from('users')
    .select('id')
    .eq('id', userId)
    .eq('role', 'USER')
    .maybeSingle();

  const {
    data: pdf,
    error: pdfError
  } = await supabase
    .from('pdfs')
    .select('id')
    .eq('id', pdfId)
    .eq('status', 'ACTIVE')
    .maybeSingle();

  if (
    userError ||
    pdfError ||
    !user ||
    !pdf
  ) {
    return json(res, 404, {
      error: 'MISSING_RECORD',
      message: 'User or PDF not found.'
    });
  }

  const {
    data: existing,
    error: existingError
  } = await supabase
    .from('grants')
    .select('id')
    .eq('user_id', userId)
    .eq('pdf_id', pdfId)
    .maybeSingle();

  if (existingError) {
    console.error(existingError);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not grant access.'
    });
  }

  if (existing) {
    const { error } = await supabase
      .from('grants')
      .update({
        status: 'ACTIVE',
        granted_at: nowIso()
      })
      .eq('id', existing.id);

    if (error) {
      console.error(error);

      return json(res, 500, {
        error: 'DATABASE_ERROR',
        message: 'Could not grant access.'
      });
    }

  } else {
    const { error } = await supabase
      .from('grants')
      .insert({
        user_id: userId,
        pdf_id: pdfId,
        status: 'ACTIVE'
      });

    if (error) {
      console.error(error);

      return json(res, 500, {
        error: 'DATABASE_ERROR',
        message: 'Could not grant access.'
      });
    }
  }

  json(res, 201, {
    message: 'PDF access granted.'
  });
}

async function handleRevokeGrant(
  req,
  res,
  url
) {
  const auth = await requireAdmin(
    req,
    res
  );

  if (!auth) return;

  const userId =
    url.searchParams.get('userId') ||
    '';

  const pdfId =
    url.searchParams.get('pdfId') ||
    '';

  const {
    data,
    error
  } = await supabase
    .from('grants')
    .update({
      status: 'REVOKED'
    })
    .eq('user_id', userId)
    .eq('pdf_id', pdfId)
    .eq('status', 'ACTIVE')
    .select('id');

  if (error) {
    console.error(error);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not revoke access.'
    });
  }

  if (!data || !data.length) {
    return json(res, 404, {
      error: 'GRANT_NOT_FOUND',
      message: 'Active access grant not found.'
    });
  }

  noContent(res);
}

async function handleForceLogout(
  req,
  res,
  userId
) {
  const auth = await requireAdmin(
    req,
    res
  );

  if (!auth) return;

  const {
    data: user,
    error: userError
  } = await supabase
    .from('users')
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (userError) {
    console.error(userError);

    return json(res, 500, {
      error: 'DATABASE_ERROR',
      message: 'Could not sign user out.'
    });
  }

  if (!user) {
    return json(res, 404, {
      error: 'USER_NOT_FOUND',
      message: 'User not found.'
    });
  }

  const { error } = await supabase
    .from('sessions')
    .update({
      revoked_at: nowIso()
    })
    .eq('user_id', userId)
    .is('revoked_at', null);

  if (error) {
    console.error(error);

    return json(res, 500, {
      error: 'SESSION_ERROR',
      message: 'Could not sign user out.'
    });
  }

  json(res, 200, {
    message:
      'Active session signed out.'
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

async function serveStatic(res, pathname) {
  const routeMap = {
    '/': '/index.html',
    '/login': '/index.html',
    '/library': '/library.html',
    '/admin': '/admin.html',
    '/reader': '/reader.html'
  };
  let requested = routeMap[pathname] || pathname;
  if (requested.includes('..')) return false;
  requested = decodeURIComponent(requested);
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) return false;

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/api/auth/login') return await handleLogin(req, res);
    if (req.method === 'POST' && pathname === '/api/auth/logout') return await handleLogout(req, res);
    if (req.method === 'GET' && pathname === '/api/me') return await handleMe(req, res);
    if (req.method === 'GET' && pathname === '/api/library') return await handleLibrary(req, res);

    const pdfFile = /^\/api\/pdfs\/([^/]+)\/file$/.exec(pathname);
    if (req.method === 'GET' && pdfFile) return await streamPdf(req, res, pdfFile[1]);

    if (req.method === 'GET' && pathname === '/api/admin/dashboard') return await handleAdminDashboard(req, res);
    if (req.method === 'POST' && pathname === '/api/admin/users') return await handleCreateUser(req, res);

    const statusMatch = /^\/api\/admin\/users\/([^/]+)\/status$/.exec(pathname);
    if (req.method === 'PATCH' && statusMatch) return await handleUserStatus(req, res, statusMatch[1]);

    const passwordMatch = /^\/api\/admin\/users\/([^/]+)\/password$/.exec(pathname);
    if (req.method === 'PATCH' && passwordMatch) return await handleResetPassword(req, res, passwordMatch[1]);

    const logoutMatch = /^\/api\/admin\/users\/([^/]+)\/logout$/.exec(pathname);
    if (req.method === 'POST' && logoutMatch) return await handleForceLogout(req, res, logoutMatch[1]);

    if (req.method === 'POST' && pathname === '/api/admin/pdfs') return await handleUploadPdf(req, res);

    const deletePdfMatch = /^\/api\/admin\/pdfs\/([^/]+)$/.exec(pathname);
    if (req.method === 'DELETE' && deletePdfMatch) return await handleDeletePdf(req, res, deletePdfMatch[1]);

    if (req.method === 'POST' && pathname === '/api/admin/grants') return await handleGrant(req, res);
    if (req.method === 'DELETE' && pathname === '/api/admin/grants') return await handleRevokeGrant(req, res, url);

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND', message: 'API route not found.' });

    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = await serveStatic(res, pathname);
      if (served) return;
    }
    json(res, 404, { error: 'NOT_FOUND', message: 'Page not found.' });
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    json(res, status, {
      error: status === 500 ? 'SERVER_ERROR' : 'REQUEST_ERROR',
      message: status === 500 ? 'Something went wrong on the server.' : error.message
    });
  }
}

async function testSupabaseConnection() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.warn('Supabase connection skipped: credentials are missing.');
    return false;
  }

  try {
    const { error } = await supabase
      .from('users')
      .select('id')
      .limit(1);

    if (error) {
      console.error('Supabase connection failed:', error.message);
      return false;
    }

    console.log('Supabase database connection: OK');
    return true;
  } catch (error) {
    console.error('Supabase connection failed:', error.message);
    return false;
  }
}

async function testSupabaseStorage() {
  try {
    const { data, error } = await supabase
      .storage
      .getBucket(SUPABASE_BUCKET);

    if (error) {
      console.error(
        'Supabase storage connection failed:',
        error.message
      );
      return false;
    }

    console.log(
      `Supabase storage bucket: OK (${data.name})`
    );

    console.log(
      `Bucket visibility: ${data.public ? 'PUBLIC' : 'PRIVATE'}`
    );

    return true;
  } catch (error) {
    console.error(
      'Supabase storage connection failed:',
      error.message
    );

    return false;
  }
}

async function ensureSupabaseAdmin() {
  const { data: existingAdmin, error: selectError } = await supabase
    .from('users')
    .select('id, username')
    .eq('username', 'admin')
    .maybeSingle();

  if (selectError) {
    throw new Error(`Failed to check Supabase admin: ${selectError.message}`);
  }

  if (existingAdmin) {
    console.log('Supabase admin account: already exists');
    return;
  }

  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 10) {
    throw new Error(
      'ADMIN_PASSWORD must contain at least 10 characters.'
    );
  }

  const { error: insertError } = await supabase
    .from('users')
    .insert({
      name: 'Business Admin',
      username: 'admin',
      password_hash: hashPassword(ADMIN_PASSWORD),
      role: 'ADMIN',
      status: 'ACTIVE'
    });

  if (insertError) {
    throw new Error(
      `Failed to create Supabase admin: ${insertError.message}`
    );
  }

  console.log('Supabase admin account: created');
}

async function main() {
  await testSupabaseConnection();
  await testSupabaseStorage();
  await ensureSupabaseAdmin();
  const server = http.createServer(router);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nPDFshelf PDF Business is running`);
    console.log(`  Local: http://localhost:${PORT}`);
    console.log(`  Admin user: admin\n`);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
