/* utilities for Brave's HAPI servers

   not really extensive enough for its own package...

*/

var underscore = require('underscore')
var wreck = require('wreck')

var exports = {}

exports.debug = function (info, request) {
  var sdebug = new (require('sdebug'))(info.id)

  sdebug.initialize({ request: { id: request.id } })
  return sdebug
}

var AsyncRoute = function () {
  if (!(this instanceof AsyncRoute)) return new AsyncRoute()

  this.internal = {}
  this.internal.method = 'GET'
  this.internal.path = '/'
}

AsyncRoute.prototype.post = function () {
  this.internal.method = 'POST'
  return this
}

AsyncRoute.prototype.get = function () {
  this.internal.method = 'GET'
  return this
}

AsyncRoute.prototype.put = function () {
  this.internal.method = 'PUT'
  return this
}

AsyncRoute.prototype.patch = function () {
  this.internal.method = 'PATCH'
  return this
}

AsyncRoute.prototype.delete = function () {
  this.internal.method = 'DELETE'
  return this
}

AsyncRoute.prototype.path = function (path) {
  this.internal.path = path
  return this
}

AsyncRoute.prototype.config = function (config) {
  if (typeof config === 'function') { config = { handler: config } }
  if (typeof config.handler === 'undefined') { throw new Error('undefined handler for ' + JSON.stringify(this.internal)) }

  return runtime => {
    var payload = { handler: { async: config.handler(runtime) } }

    underscore.keys(config).forEach(key => {
      if ((key !== 'handler') && (typeof config[key] !== 'undefined')) payload[key] = config[key]
    })

    return {
      method: this.internal.method,
      path: this.internal.path,
      config: payload
    }
  }
}

exports.routes = { async: AsyncRoute }

var ErrorInspect = function (err) {
  var i, properties

  if (!err) return

  properties = [ 'message', 'isBoom', 'isServer' ]
  if (!err.isBoom) properties.push('stack')
  i = underscore.pick(err, properties)
  if ((err.output) && (err.output.payload)) { underscore.defaults(i, { payload: err.output.payload }) }

  return i
}

exports.error = { inspect: ErrorInspect }

/*
 * Async wrapper for wreck.get to return the response payload.
 */
var WreckGet = async function (server, opts) {
  return new Promise((resolve, reject) => {
    wreck.get(server, opts, (err, response, body) => {
      if (err) return reject(err)

      resolve(body)
    })
  })
}

/*
 * Async wrapper for wreck.post to return the response payload.
 */
var WreckPost = async function (server, opts) {
  return new Promise((resolve, reject) => {
    wreck.post(server, opts, (err, response, body) => {
      if (err) return reject(err)

      resolve(body)
    })
  })
}

exports.wreck = { get: WreckGet, post: WreckPost }

module.exports = exports
