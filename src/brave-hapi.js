/* utilities for Brave's HAPI servers

   not really extensive enough for its own package...

*/

var path = require('path')
var ProxyAgent = require('proxy-agent')
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
  this.internal.extras = {}
}

AsyncRoute.prototype.get = function () {
  this.internal.method = 'GET'
  return this
}

AsyncRoute.prototype.post = function () {
  this.internal.method = 'POST'
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

AsyncRoute.prototype.whitelist = function () {
  this.internal.extras = {
    ext: {
      onPreAuth: {
        method: require('./hapi-auth-whitelist').authenticate
      }
    }
  }

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
      config: underscore.extend(payload, this.internal.extras)
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

var npminfo = require(path.join(__dirname, '..', 'package'))
var WreckUA = npminfo.name + '/' + npminfo.version + ' wreck/' + npminfo.dependencies.wreck
underscore.keys(process.versions).forEach((version) => {
  WreckUA += ' ' + version + '/' + process.versions[version]
})

var WreckProxy = function (server, opts) {
  var useProxyP

  if (!opts) opts = {}
  if (!opts.headers) opts.headers = {}
  if (!opts.headers['user-agent']) opts.headers['user-agent'] = WreckUA

  if (typeof opts.useProxyP === 'undefined') return { server: server, opts: opts }

  useProxyP = opts.useProxyP
  opts = underscore.omit(opts, [ 'useProxyP' ])
  if ((!useProxyP) || (!process.env.FIXIE_URL)) return { server: server, opts: opts }

  return { server: server, opts: underscore.extend(opts, { agent: new ProxyAgent(process.env.FIXIE_URL) }) }
}

var WreckGet = async function (server, opts) {
  var params = WreckProxy(server, opts)

  return new Promise((resolve, reject) => {
    wreck.get(params.server, params.opts, (err, response, body) => {
      if (err) return reject(err)

      resolve(body)
    })
  })
}

var WreckPost = async function (server, opts) {
  var params = WreckProxy(server, opts)

  return new Promise((resolve, reject) => {
    wreck.post(params.server, params.opts, (err, response, body) => {
      if (err) return reject(err)

      resolve(body)
    })
  })
}

var WreckPatch = async function (server, opts) {
  var params = WreckProxy(server, opts)

  return new Promise((resolve, reject) => {
    wreck.patch(params.server, params.opts, (err, response, body) => {
      if (err) return reject(err)

      resolve(body)
    })
  })
}

exports.wreck = { get: WreckGet, patch: WreckPatch, post: WreckPost }

module.exports = exports
