import { greetingFor } from './greet.js';
import { total } from './cart.js';

// Guest checkout is allowed: session.user is null for guests.
export function checkoutPage(session, items, coupons) {
  return {
    greeting: greetingFor(session.user),
    total: total(items, coupons),
  };
}
