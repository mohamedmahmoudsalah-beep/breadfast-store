/**
 * App-wide technical constants.
 * Business rules (fees, limits, slots, business-day start, ...) are NOT here:
 * they live in database tables and are edited by admins.
 */
export const APP_TIMEZONE = "Africa/Cairo";
export const CURRENCY = "EGP";

/** Money is always handled in integer piastres (1 EGP = 100 piastres). */
export function formatEgp(piastres: number): string {
  return new Intl.NumberFormat("ar-EG", {
    style: "currency",
    currency: CURRENCY,
  }).format(piastres / 100);
}
