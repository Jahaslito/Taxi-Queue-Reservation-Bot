#!/usr/bin/env node
// Create a new admin user.
//
// Usage:
//   node scripts/create-admin.js                          # interactive prompts
//   node scripts/create-admin.js <username> <password>    # one-shot (avoid on shared terminals — shows up in history)
//
// On production, prefer the interactive form so the password isn't recorded
// in shell history. Run from the project root so .env is picked up.

require('dotenv').config();
const bcrypt   = require('bcryptjs');
const readline = require('readline');
const db       = require('../src/config/database');
const Admin    = require('../src/models/Admin');

function prompt(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
      return;
    }
    // Mute stdout while the user types the password
    const stdout = process.stdout;
    const origWrite = stdout.write.bind(stdout);
    rl.question(question, (answer) => {
      stdout.write = origWrite;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    stdout.write = (chunk, ...rest) => {
      if (typeof chunk === 'string' && chunk.includes(question)) return origWrite(chunk, ...rest);
      return origWrite('', ...rest);
    };
  });
}

async function main() {
  let [, , username, password] = process.argv;

  if (!username) username = (await prompt('Admin username: ')).trim();
  if (!username) { console.error('Username is required.'); process.exit(1); }

  if (!password) password = await prompt('Admin password (input hidden): ', { hidden: true });
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const existing = await Admin.findByUsername(username);
  if (existing) {
    console.error(`Admin "${username}" already exists (id=${existing.id}).`);
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(password, 10);
  const admin = await Admin.create({ username, password_hash });
  console.log(`✓ Created admin: id=${admin.id}, username=${admin.username}`);
}

main()
  .catch((err) => { console.error('Failed to create admin:', err.message); process.exitCode = 1; })
  .finally(() => db.destroy());
