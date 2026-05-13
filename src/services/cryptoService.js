const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';

function getKey() {
  const secret = process.env.ENCRYPTION_KEY;
  return crypto.scryptSync(secret, 'san-queue-salt', 32);
}

function encrypt(text) {
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(encryptedText) {
  const [ivHex, encryptedHex] = encryptedText.split(':');
  const iv       = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
