import express from 'express'
import pg from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const app = express()
const port = Number(process.env.PORT || 3001)
const p2pArmyUrl = 'https://p2p.army/v1/api/get_p2p_order_book'
const { Pool } = pg
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
})
const refreshInterval = 3 * 60 * 60 * 1000
const uploadDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'upliadFile')
const scryptAsync = promisify(crypto.scrypt)

app.use(express.json({ limit: '12mb' }))
app.use((_request, response, next) => {
  const allowedOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:3000'
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  next()
})

async function refreshUsdtToBirr() {
  if (!process.env.P2P_ARMY_API_KEY) {
    throw new Error('P2P Army API key is not configured')
  }

  const upstream = await fetch(p2pArmyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-APIKEY': process.env.P2P_ARMY_API_KEY },
    body: JSON.stringify({ market: 'bingx', fiat: 'ETB', asset: 'USDT', side: 'SELL', limit: 1, amount: 100000 }),
  })
  const data = await upstream.json()
  if (!upstream.ok || !data.ads?.[0]?.price) throw new Error(data?.errText || 'No BingX P2P price returned')

  const price = Number(data.ads[0].price)
  await pool.query(`
    INSERT INTO usdtobirr (id, usdt, birr)
    VALUES (1, 1, $1)
    ON CONFLICT (id) DO UPDATE SET usdt = EXCLUDED.usdt, birr = EXCLUDED.birr, created_at = NOW()
  `, [price])
  console.log(`USDT/Birr database value updated: ${price}`)
}

app.get('/api/usdt-to-birr', async (_request, response) => {
  try {
    const result = await pool.query('SELECT birr, deduction, created_at FROM usdtobirr WHERE id = 1')
    if (!result.rows[0]) return response.status(404).json({ error: 'USDT/Birr value is not available yet' })
    return response.json(result.rows[0])
  } catch (error) {
    return response.status(500).json({ error: `Database unavailable: ${error.message}` })
  }
})

app.get('/api/rate', async (_request, response) => {
  try {
    const result = await pool.query('SELECT birr, deduction, created_at FROM usdtobirr WHERE id = 1')
    if (!result.rows[0]) return response.status(404).json({ error: 'Rate is not available yet' })
    return response.json(result.rows[0])
  } catch (error) {
    return response.status(500).json({ error: `Database unavailable: ${error.message}` })
  }
})

app.get('/api/admin/rate', async (_request, response) => {
  try {
    const result = await pool.query('SELECT birr, deduction, created_at FROM usdtobirr WHERE id = 1')
    if (!result.rows[0]) return response.status(404).json({ error: 'Rate is not available yet' })
    return response.json(result.rows[0])
  } catch (error) {
    return response.status(500).json({ error: `Database unavailable: ${error.message}` })
  }
})

app.post('/api/admin/deduction', async (request, response) => {
  const deduction = Number(request.body?.deduction)
  if (!Number.isFinite(deduction) || deduction < 0) return response.status(400).json({ error: 'Deduction must be a positive number or zero' })
  try {
    const result = await pool.query('UPDATE usdtobirr SET deduction = $1 WHERE id = 1 RETURNING birr, deduction, created_at', [deduction])
    if (!result.rows[0]) return response.status(404).json({ error: 'Rate is not available yet' })
    return response.json(result.rows[0])
  } catch (error) {
    return response.status(500).json({ error: `Deduction could not be saved: ${error.message}` })
  }
})

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scryptAsync(password, salt, 64)
  return `${salt}:${derived.toString('hex')}`
}

async function verifyPassword(password, stored) {
  const [salt, key] = String(stored).split(':')
  if (!salt || !key) return false
  const derived = await scryptAsync(password, salt, 64)
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), derived)
}

app.post('/api/login', async (request, response) => {
  const { role, email, username, password } = request.body || {}
  const loginEmail = String(email || username || '').trim().toLowerCase()
  if (!['user', 'agent'].includes(role) || !loginEmail || !password?.trim()) {
    return response.status(400).json({ error: 'Role, username, and password are required' })
  }
  try {
    const result = await pool.query('SELECT email, role, password_hash, adminstatus FROM exchange_users WHERE email = $1 AND role = $2', [loginEmail, role])
    const account = result.rows[0]
    if (!account || !(await verifyPassword(password, account.password_hash))) return response.status(401).json({ error: 'Invalid email or password' })
    return response.json({ ok: true, role: account.role, email: account.email, adminstatus: account.adminstatus })
  } catch (error) {
    return response.status(500).json({ error: `Login unavailable: ${error.message}` })
  }
})

app.post('/api/receipts', async (request, response) => {
  const { username, paymentMethod, fileName, data } = request.body || {}
  if (!username?.trim() || !['zelle', 'cashapp'].includes(paymentMethod) || !fileName || !data) {
    return response.status(400).json({ error: 'Username, payment method, and receipt are required' })
  }
  const match = String(data).match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return response.status(400).json({ error: 'Receipt format is invalid' })
  const extension = path.extname(fileName).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(extension)) {
    return response.status(400).json({ error: 'Use a PNG, JPG, WEBP, or PDF receipt' })
  }
  try {
    await mkdir(uploadDirectory, { recursive: true })
    const fileBuffer = Buffer.from(match[2], 'base64')
    const savedName = `${Date.now()}-${crypto.randomUUID()}${extension}`
    await mkdir(uploadDirectory, { recursive: true })
    await writeFile(path.join(uploadDirectory, savedName), fileBuffer)
    const saved = await pool.query('INSERT INTO exchange_receipts (user_email, payment_method, original_file, stored_file, mime_type, file_data, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at', [username.trim().toLowerCase(), paymentMethod, fileName, savedName, match[1], fileBuffer, 'submitted'])
    return response.status(201).json({ ok: true, id: saved.rows[0].id, fileName: savedName, paymentMethod, createdAt: saved.rows[0].created_at })
  } catch (error) {
    return response.status(500).json({ error: `Receipt could not be saved: ${error.message}` })
  }
})

app.get('/api/receipts', async (request, response) => {
  const email = String(request.query.email || '').trim().toLowerCase()
  try {
    const result = email
      ? await pool.query('SELECT id, user_email, payment_method, original_file, status, created_at FROM exchange_receipts WHERE user_email = $1 ORDER BY created_at DESC', [email])
      : await pool.query('SELECT id, user_email, payment_method, original_file, status, created_at FROM exchange_receipts ORDER BY created_at DESC')
    return response.json({ receipts: result.rows })
  } catch (error) {
    return response.status(500).json({ error: `Receipt history unavailable: ${error.message}` })
  }
})

app.listen(port, '0.0.0.0', async () => {
  console.log(`Exchange backend listening on port ${port}`)
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS usdtobirr (id BIGINT PRIMARY KEY, usdt NUMERIC(20,8) NOT NULL, birr NUMERIC(20,8) NOT NULL, deduction NUMERIC(20,8) NOT NULL DEFAULT 9, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())')
    await pool.query('ALTER TABLE usdtobirr ADD COLUMN IF NOT EXISTS deduction NUMERIC(20,8) NOT NULL DEFAULT 9')
    await pool.query('CREATE TABLE IF NOT EXISTS exchange_users (email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN (\'agent\', \'user\')), password_hash TEXT NOT NULL, adminstatus BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())')
    await pool.query('ALTER TABLE exchange_users ADD COLUMN IF NOT EXISTS adminstatus BOOLEAN NOT NULL DEFAULT FALSE')
    await pool.query('CREATE TABLE IF NOT EXISTS exchange_receipts (id BIGSERIAL PRIMARY KEY, user_email TEXT NOT NULL, payment_method TEXT NOT NULL CHECK (payment_method IN (\'zelle\', \'cashapp\')), original_file TEXT NOT NULL, stored_file TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT \'application/octet-stream\', file_data BYTEA, status TEXT NOT NULL DEFAULT \'submitted\', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())')
    await pool.query('ALTER TABLE exchange_receipts ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT \'application/octet-stream\'')
    await pool.query('ALTER TABLE exchange_receipts ADD COLUMN IF NOT EXISTS file_data BYTEA')
    for (const account of [{ email: 'agent@exchange.com', role: 'agent', adminstatus: false }, { email: 'user@exchange.com', role: 'user', adminstatus: false }, { email: 'admin@exchange.com', role: 'agent', adminstatus: true }]) {
      const passwordHash = await hashPassword('12811281')
      await pool.query('INSERT INTO exchange_users (email, role, password_hash, adminstatus) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET adminstatus = EXCLUDED.adminstatus', [account.email, account.role, passwordHash, account.adminstatus])
    }
    await refreshUsdtToBirr()
  } catch (error) { console.error('Backend initialization failed:', error.message) }
  setInterval(() => refreshUsdtToBirr().catch((error) => console.error('Scheduled USDT/Birr refresh failed:', error.message)), refreshInterval)
})
