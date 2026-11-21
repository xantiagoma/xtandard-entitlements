/**
 * Key layout for state storage and the counter store. Pure string helpers;
 * ids are URI-encoded so any customer / grant id is safe in a key.
 *
 * ```txt
 * state storage                              counter store
 * ent/customers/{customer}  -> CustomerState  usage/{customer}/{feature}/{period}  allowance bucket
 * ent/reservations/{id}     -> Reservation    grant/{customer}/{grantId}           one-off grant
 * ent/links/{provider}/{id} -> customer id    cap/{customer}/{feature}             capacity
 * ent/activity/{customer}   -> ActivityEntry[] daily/{customer}/{feature}/{date}    usage series
 * ent/activity-log          -> ActivityEntry[] idem/{customer}/{key}                idempotency claim
 *                                              thr/{customer}/{feature}/{period}/{t} threshold claim
 *                                              evt/{provider}/{eventId}             webhook claim
 * ```
 *
 * @module
 */

/** Root namespace for state-storage keys. */
export const ROOT = "ent";

const e = encodeURIComponent;

/** Decode the last segment of a key. */
export const lastSegment = (key: string): string => decodeURIComponent(key.split("/").pop() ?? "");

// --- state storage ---------------------------------------------------------

/** Prefix of every customer document. */
export const customersPrefix = () => `${ROOT}/customers/`;
/** One customer's state. */
export const customerKey = (customer: string) => `${customersPrefix()}${e(customer)}`;
/** Prefix of every reservation. */
export const reservationsPrefix = () => `${ROOT}/reservations/`;
/** One reservation. */
export const reservationKey = (id: string) => `${reservationsPrefix()}${e(id)}`;
/** Provider customer → our customer id. */
export const linkKey = (provider: string, providerCustomer: string) =>
  `${ROOT}/links/${e(provider)}/${e(providerCustomer)}`;
/** Per-customer activity list. */
export const activityKey = (customer: string) => `${ROOT}/activity/${e(customer)}`;
/** Global (all customers) recent activity list. */
export const activityLogKey = () => `${ROOT}/activity-log`;

// --- counter store -----------------------------------------------------------

/** Period allowance bucket. */
export const usageKey = (customer: string, feature: string, period: string) =>
  `usage/${e(customer)}/${e(feature)}/${e(period)}`;
/** Prefix of every period counter for one customer + feature. */
export const usagePrefix = (customer: string, feature: string) =>
  `usage/${e(customer)}/${e(feature)}/`;
/** One-off grant bucket. */
export const grantKey = (customer: string, grantId: string) => `grant/${e(customer)}/${e(grantId)}`;
/** Capacity counter. */
export const capacityKey = (customer: string, feature: string) =>
  `cap/${e(customer)}/${e(feature)}`;
/** Daily usage series point (YYYY-MM-DD, UTC). */
export const dailyKey = (customer: string, feature: string, date: string) =>
  `daily/${e(customer)}/${e(feature)}/${date}`;
/** Prefix of the daily series for one customer + feature. */
export const dailyPrefix = (customer: string, feature: string) =>
  `daily/${e(customer)}/${e(feature)}/`;
/** Idempotency claim. */
export const idempotencyKey = (customer: string, key: string) => `idem/${e(customer)}/${e(key)}`;
/** Once-per-period threshold claim. */
export const thresholdKey = (
  customer: string,
  feature: string,
  period: string,
  threshold: number,
) => `thr/${e(customer)}/${e(feature)}/${e(period)}/${threshold}`;
/** Billing webhook event claim. */
export const eventKey = (provider: string, eventId: string) => `evt/${e(provider)}/${e(eventId)}`;
