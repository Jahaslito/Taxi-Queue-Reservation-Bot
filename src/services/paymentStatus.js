// ─── Payment status derivation ────────────────────────────────────────────────
// Turns the raw billing columns on a driver row into a single status the admin
// UI can render as a badge, plus flags that drive the lock / clear actions.
//
// There is no dedicated "has a card" column — card presence is established once,
// against Stripe truth, by scripts/backfill-card-required.js, which stamps
// card_required_by on drivers with no card. So:
//   • card_required_by set            → no card on file (in grace / overdue / locked)
//   • active/trialing + customer id   → card on file (went through Checkout)
//   • active + no customer id         → grandfathered, card unverified (run backfill)
//   • anything else                   → reflect the subscription status
//
// Pure / no I/O — exported for unit testing.
//
// Returns { code, label, noCard }:
//   code   — stable identifier for styling / tests
//   label  — human text for the badge
//   noCard — true when there is (probably) no usable card on file; the admin
//            "Require card" lock action is offered for these.

function derivePaymentStatus(driver = {}) {
  const { subscription_status, stripe_customer_id, card_required_by, is_active } = driver;

  if (card_required_by) {
    const deadline = new Date(card_required_by).getTime();
    if (is_active === false) {
      return { code: 'card_locked', label: 'No card — locked out', noCard: true };
    }
    const days = Math.ceil((deadline - Date.now()) / 86_400_000);
    if (days > 0) {
      return { code: 'card_grace', label: `No card — ${days}d left`, noCard: true };
    }
    return { code: 'card_overdue', label: 'No card — overdue', noCard: true };
  }

  switch (subscription_status) {
    case 'active':
      return stripe_customer_id
        ? { code: 'card_on_file', label: 'Card on file', noCard: false }
        : { code: 'grandfathered', label: 'No card verified', noCard: true };
    case 'trialing':
      return stripe_customer_id
        ? { code: 'trialing', label: 'Card on file (trial)', noCard: false }
        : { code: 'grandfathered', label: 'No card verified', noCard: true };
    case 'past_due':
      return { code: 'past_due', label: 'Payment overdue', noCard: false };
    case 'canceled':
      return { code: 'canceled', label: 'Canceled', noCard: false };
    case 'unpaid':
      return { code: 'unpaid', label: 'Unpaid', noCard: false };
    case 'incomplete':
      return { code: 'incomplete', label: 'Incomplete', noCard: false };
    default:
      return { code: 'none', label: 'No subscription', noCard: true };
  }
}

module.exports = { derivePaymentStatus };
