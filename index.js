/**
 * dsh-conversation-find — host half.
 *
 * The feature lives entirely in the browser bundle (`client.js`). This row
 * exists so the Loader mounts a package that declares `dsh.client`, which is
 * what puts the bundle into the Web module roster; the host has nothing to do.
 */
const name = 'dsh-conversation-find'

/** No host-side surface: no services, no routes, no settings namespace. */
function apply() {}

module.exports = { name, apply }
