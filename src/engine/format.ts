/** Indian-grouped rupee formatting: 1234567 → "₹12,34,567". Integer rupees only. */
export function formatINR(amount: number): string {
  const negative = amount < 0;
  const digits = Math.round(Math.abs(amount)).toString();
  let grouped = digits;
  if (digits.length > 3) {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  return `${negative ? '-' : ''}₹${grouped}`;
}
