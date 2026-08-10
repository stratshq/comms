#!/usr/bin/env node
/* @license Enterprise */

/**
 * License key issuing CLI.
 *
 * Two subcommands, no dependencies:
 *
 *   node scripts/issue-license.mjs keygen
 *   node scripts/issue-license.mjs sign --sub "Acme Inc" --seats 25 --days 365
 *
 * `keygen` is run once, ever. Paste the public half into
 * BUILTIN_LICENSE_PUBLIC_KEY in src/gate.ts and keep the private half in a
 * secret manager — anyone holding it can mint licenses for every build that
 * trusts the matching public key.
 */

import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';

/** DER prefix for a PKCS#8-wrapped Ed25519 private key, ahead of the 32-byte seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      out[token.slice(2)] = next && !next.startsWith('--') ? ((i += 1), next) : 'true';
    }
  }
  return out;
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function keygen() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);

  console.log('Ed25519 license keypair\n');
  console.log('Public key  (paste into BUILTIN_LICENSE_PUBLIC_KEY in src/gate.ts,');
  console.log('             or set COMMS_LICENSE_PUBLIC_KEY to override a build):\n');
  console.log(`  ${pub.toString('base64')}\n`);
  console.log('Private key (keep secret — store it in a secret manager, never in git):\n');
  console.log(`  ${priv.toString('base64')}\n`);
  console.log('Sign licenses with:');
  console.log('  COMMS_LICENSE_PRIVATE_KEY=<private> node scripts/issue-license.mjs sign \\');
  console.log('    --sub "Acme Inc" --seats 25 --days 365');
}

function privateKeyFromSeed(base64Seed) {
  const seed = Buffer.from(base64Seed.trim(), 'base64');
  if (seed.length !== 32) die('private key must be a base64-encoded 32-byte Ed25519 seed');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function signLicense(args) {
  const secret = args.key ?? process.env.COMMS_LICENSE_PRIVATE_KEY;
  if (!secret) die('pass --key or set COMMS_LICENSE_PRIVATE_KEY (see `keygen`)');

  const sub = args.sub ?? args.to;
  if (!sub) die('pass --sub "Customer Name"');

  const seats = Number(args.seats ?? 0);
  if (!Number.isInteger(seats) || seats < 0)
    die('--seats must be a non-negative integer (0 = unlimited)');

  const days = Number(args.days ?? 365);
  if (!Number.isInteger(days) || days < 0)
    die('--days must be a non-negative integer (0 = perpetual)');

  const features = (args.features ?? '*')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    sub,
    seats,
    features,
    iat: nowSeconds,
    exp: days === 0 ? 0 : nowSeconds + days * 86_400,
  };

  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKeyFromSeed(secret));
  const key = `comms_${payload}.${signature.toString('base64url')}`;

  console.log(`Issued to    ${claims.sub}`);
  console.log(`Seats        ${claims.seats === 0 ? 'unlimited' : claims.seats}`);
  console.log(`Features     ${claims.features.join(', ')}`);
  console.log(
    `Expires      ${claims.exp === 0 ? 'never' : new Date(claims.exp * 1000).toISOString()}`,
  );
  console.log('\nCOMMS_LICENSE_KEY=');
  console.log(key);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'keygen':
    keygen();
    break;
  case 'sign':
    signLicense(parseArgs(rest));
    break;
  default:
    console.error('usage: issue-license.mjs <keygen|sign> [options]');
    process.exit(1);
}
