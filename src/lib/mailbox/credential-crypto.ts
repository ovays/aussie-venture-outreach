import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'

function encryptionKey(): Buffer {
  const raw = process.env.MAILBOX_CREDENTIAL_ENCRYPTION_KEY?.trim()
  if (!raw) throw new Error('MAILBOX_CREDENTIAL_ENCRYPTION_KEY is not configured')
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('MAILBOX_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes')
  return key
}

export function encryptMailboxCredential(value: string): string {
  if (!value) throw new Error('Cannot encrypt an empty mailbox credential')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export function decryptMailboxCredential(blob: string): string {
  const [version, iv, tag, ciphertext] = blob.split('.')
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error('Invalid encrypted mailbox credential')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
}
