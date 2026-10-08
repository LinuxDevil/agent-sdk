// Greeting shown on the checkout page (added by PR #42).
export function greetingFor(user) {
  const local = user.email.split('@')[0];
  return `Welcome back, ${local}!`;
}
