/* @license Enterprise */

import { requireFeature } from './gate.js';

/**
 * Billing seam.
 *
 * Comms Cloud is the same code as the self-hosted build with this switched on,
 * so nothing here may be imported from an open source code path at module load
 * time. Call `getBillingProvider()` behind `hasFeature('billing')` instead.
 *
 * The provider interface is deliberately payment-processor-agnostic: the
 * processor is an implementation detail, and keeping it behind this boundary is
 * what stops Stripe types leaking into the inbox.
 */

export type PlanId = 'free' | 'team' | 'business';

export interface Plan {
  id: PlanId;
  name: string;
  /** Price per seat per month, in the smallest currency unit. */
  unitAmount: number;
  currency: string;
  /** Seat ceiling; null means unlimited. */
  maxSeats: number | null;
}

export type SubscriptionState = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';

export interface Subscription {
  planId: PlanId;
  state: SubscriptionState;
  seats: number;
  /** End of the paid period, or of the trial when trialing. */
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface CheckoutRequest {
  planId: PlanId;
  seats: number;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingProvider {
  listPlans(): Promise<Plan[]>;
  getSubscription(): Promise<Subscription>;
  /** Returns a hosted checkout URL to redirect the operator to. */
  createCheckout(request: CheckoutRequest): Promise<{ url: string }>;
  /** Returns a hosted billing-portal URL for managing an existing subscription. */
  createPortalSession(returnUrl: string): Promise<{ url: string }>;
  /**
   * Verify and apply a processor webhook. Implementations must verify the
   * signature before trusting the payload, and must be idempotent — processors
   * retry, and a double-applied seat change is a billing incident.
   */
  handleWebhook(rawBody: string, signature: string): Promise<void>;
}

/** The subscription state reported when billing is off, i.e. every self-hosted install. */
export const UNBILLED: Subscription = {
  planId: 'free',
  state: 'none',
  seats: 0,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

let provider: BillingProvider | null = null;

/**
 * Install the concrete provider at startup. Kept as registration rather than a
 * static import so the open source build never pulls in a payments SDK.
 */
export function registerBillingProvider(impl: BillingProvider): void {
  provider = impl;
}

/**
 * The active billing provider. Throws when billing is unlicensed or no provider
 * has been registered — callers gate on `hasFeature('billing')` first and show
 * the self-hosted UI otherwise.
 */
export function getBillingProvider(): BillingProvider {
  requireFeature('billing');
  if (!provider) {
    throw new Error(
      'Billing is licensed but no provider is registered. Call registerBillingProvider() during startup.',
    );
  }
  return provider;
}

/** Reset registration (tests only). */
export function _resetBillingProvider(): void {
  provider = null;
}
