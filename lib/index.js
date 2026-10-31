/**
 * Host half of the completion-notify bundle.
 *
 * The feature lives entirely in the browser: the client half
 * (`./client`, declared by `dsh.client`) watches session turn completion and
 * raises a system notification. This entry only exists so the package can be
 * a profile bundle row and so the client-modules scanner finds the
 * `dsh.client` declaration on a mounted Loader entry.
 *
 * @module dsh-plugin-completion-notify
 */

/** Host-side body: intentionally no behavior. */
export function apply() {}
