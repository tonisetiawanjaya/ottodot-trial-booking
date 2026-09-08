import { randomUUID } from 'node:crypto';

/**
 * Minimal payment-provider port. In production this would wrap Stripe (or
 * similar): charge == create + confirm a PaymentIntent, refund == refund it.
 * The booking service depends only on this interface, so tests can drive the
 * exact interleaving they need (see test/helpers.ts, ControlledProvider).
 */
export interface ChargeRequest {
  amountCents: number;
  currency: string;
  /** Mock card number / token. See TEST_CARDS. */
  card: string;
  /** payment_attempt id; a real provider would use it as the idempotency key. */
  idempotencyKey: string;
  metadata: { bookingId: string };
  /** Dev/demo only: simulate a slow provider round-trip. */
  delayMs?: number;
}

export type ChargeResult =
  | { ok: true; providerRef: string }
  | { ok: false; failureCode: string };

export interface PaymentProvider {
  charge(req: ChargeRequest): Promise<ChargeResult>;
  refund(providerRef: string, amountCents: number): Promise<{ refundRef: string }>;
}

/** Stripe-style test cards. Any other number succeeds. */
export const TEST_CARDS: Record<string, { label: string; failureCode: string | null }> = {
  '4242424242424242': { label: 'Visa 4242 (succeeds)', failureCode: null },
  '4000000000000002': { label: 'Visa 0002 (declined)', failureCode: 'card_declined' },
  '4000000000009995': { label: 'Visa 9995 (insufficient funds)', failureCode: 'insufficient_funds' },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MockPaymentProvider implements PaymentProvider {
  charges: Array<ChargeRequest & { result: ChargeResult }> = [];
  refunds: Array<{ providerRef: string; amountCents: number; refundRef: string }> = [];

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (req.delayMs && req.delayMs > 0) await sleep(req.delayMs);
    const digits = req.card.replace(/\D/g, '');
    const known = TEST_CARDS[digits];
    const result: ChargeResult = known?.failureCode
      ? { ok: false, failureCode: known.failureCode }
      : { ok: true, providerRef: `ch_${randomUUID().slice(0, 8)}` };
    this.charges.push({ ...req, result });
    return result;
  }

  async refund(providerRef: string, amountCents: number): Promise<{ refundRef: string }> {
    const refundRef = `re_${randomUUID().slice(0, 8)}`;
    this.refunds.push({ providerRef, amountCents, refundRef });
    return { refundRef };
  }
}
