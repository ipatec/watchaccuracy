'use strict';

/**
 * Returns true when the request carries a valid write token for the given watch.
 * The token must be non-empty and match the watch's stored write_token.
 */
function hasValidWriteToken(req, watch) {
  return !!(req.query.write_token &&
    watch.write_token &&
    req.query.write_token === watch.write_token);
}

module.exports = { hasValidWriteToken };
