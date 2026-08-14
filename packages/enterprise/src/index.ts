/* @license Enterprise */

/**
 * @comms/enterprise — the paid edition.
 *
 * NOT covered by the AGPLv3 in the repository root. See ./LICENSE (or
 * ../../packages/enterprise/LICENSE from elsewhere in the tree) before using
 * any of this in production.
 *
 * Importing this package is always safe: with no license key present every gate
 * returns false and the app runs as the community edition.
 */

export * from './features.js';
export * from './license.js';
export * from './gate.js';
export * from './billing.js';
export * from './sso.js';
export * from './audit.js';
