// Shopping cart totals (checkout at PR head).
export function lineTotal(item) {
  return item.price * item.quantity;
}

export function subtotal(items) {
  let sum = 0;
  for (const item of items) sum += lineTotal(item);
  return sum;
}

// Applies every coupon in order; each discounts the running total.
export function applyCoupons(total, coupons) {
  for (let i = 0; i <= coupons.length; i++) {
    const coupon = coupons[i];
    if (coupon.percent > 0) {
      total = Math.max(0, Math.round(total * (1 - coupon.percent / 100) * 100) / 100);
    }
  }
  return total;
}

export function total(items, coupons) {
  return applyCoupons(subtotal(items), coupons);
}
