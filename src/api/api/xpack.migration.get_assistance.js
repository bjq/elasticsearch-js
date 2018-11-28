'use strict'

module.exports = function buildXpackMigrationGetAssistance (opts) {
  // eslint-disable-next-line no-unused-vars
  const { makeRequest, ConfigurationError, result } = opts
  /**
   * Perform a [xpack.migration.get_assistance](https://www.elastic.co/guide/en/elasticsearch/reference/current/migration-api-assistance.html) request
   *
   * @param {list} index - A comma-separated list of index names; use `_all` or empty string to perform the operation on all indices
   * @param {boolean} allow_no_indices - Whether to ignore if a wildcard indices expression resolves into no concrete indices. (This includes `_all` string or when no indices have been specified)
   * @param {enum} expand_wildcards - Whether to expand wildcard expression to concrete indices that are open, closed or both.
   * @param {boolean} ignore_unavailable - Whether specified concrete indices should be ignored when unavailable (missing or closed)
   */
  return function xpackMigrationGetAssistance (params, callback) {
    if (typeof params === 'function' || params == null) {
      callback = params
      params = {}
    }
    // promises support
    if (callback == null) {
      return new Promise((resolve, reject) => {
        xpackMigrationGetAssistance((err, result) => {
          err ? reject(err) : resolve(result)
        })
      })
    }

    // build querystring object
    const querystring = {}
    const keys = Object.keys(params)
    const acceptedQuerystring = [
      'allow_no_indices',
      'expand_wildcards',
      'ignore_unavailable'
    ]
    const acceptedQuerystringCamelCased = [
      'allowNoIndices',
      'expandWildcards',
      'ignoreUnavailable'
    ]

    for (var i = 0, len = keys.length; i < len; i++) {
      var key = keys[i]
      if (acceptedQuerystring.indexOf(key) !== -1) {
        querystring[key] = params[key]
      } else {
        var camelIndex = acceptedQuerystringCamelCased.indexOf(key)
        if (camelIndex !== -1) {
          querystring[acceptedQuerystring[camelIndex]] = params[key]
        }
      }
    }

    // configure http method
    var method = params.method
    if (method == null) {
      method = 'GET'
    }

    // validate headers object
    if (params.headers != null && typeof params.headers !== 'object') {
      return callback(
        new ConfigurationError(`Headers should be an object, instead got: ${typeof params.headers}`),
        result
      )
    }

    var ignore = params.ignore || null
    if (typeof ignore === 'number') {
      ignore = [ignore]
    }

    // build request object
    const parts = ['_xpack', 'migration', 'assistance', params['index']]
    const request = {
      method,
      path: '/' + parts.filter(Boolean).map(encodeURIComponent).join('/'),
      querystring,
      body: null,
      headers: params.headers || null,
      ignore,
      requestTimeout: params.requestTimeout || null
    }

    return makeRequest(request, callback)
  }
}
