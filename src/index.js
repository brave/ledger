process.env.NEW_RELIC_NO_CONFIG_FILE = true
if (process.env.NEW_RELIC_APP_NAME && process.env.NEW_RELIC_LICENSE_KEY) { var newrelic = require('newrelic') }
if (!newrelic) {
  newrelic = {
    createBackgroundTransaction: (name, group, cb) => { return (cb || group) },
    noticeError: (ex, params) => {},
    recordCustomEvent: (eventType, attributes) => {},
    endTransaction: () => {}
  }
}

var boom = require('boom')
var braveHapi = require('./brave-hapi')
var debug = new (require('sdebug'))('web')
var Hapi = require('hapi')
var path = require('path')
var routes = require('./controllers/index')
var underscore = require('underscore')
var url = require('url')
var whitelist = require('./hapi-auth-whitelist')

var npminfo = require(path.join(__dirname, '..', 'package'))
var runtime = require('./runtime.js')
runtime.newrelic = newrelic

var server = new Hapi.Server()
server.connection({ port: process.env.PORT })

debug.initialize({ web: { id: server.info.id } })

if (process.env.NODE_ENV !== 'production') {
  process.on('warning', (warning) => {
    debug('warning', underscore.pick(warning, [ 'name', 'message', 'stack' ]))
  })
}

server.register(
  [ require('bell'),
    require('blipp'),
/*
  {
    register: require('crumb'),
    options: {
      cookieOptions: {
        clearInvalid: true,
        isSecure: true
      }
    }
  },
 */
    require('hapi-async-handler'),
    require('hapi-auth-bearer-token'),
    require('hapi-auth-cookie'),
    whitelist,
    require('inert'),
    require('vision'),
    {
      register: require('hapi-rate-limiter'),
      options: {
        defaultRate: (request) => {
/*  access type            requests/minute per IP address
    -------------------    ------------------------------
    anonymous (browser)       60
    administrator (github)  3000
    server (bearer token)  60000
 */
          var authorization, parts, token, tokenlist
          var ipaddr = whitelist.ipaddr(request)
          var limit = 60

          if (ipaddr === '127.0.0.1') return { limit: Number.MAX_SAFE_INTEGER, window: 1 }

          if (whitelist.authorizedP(ipaddr)) {
            authorization = request.raw.req.headers.authorization
            if (authorization) {
              parts = authorization.split(/\s+/)
              token = (parts[0].toLowerCase() === 'bearer') && parts[1]
            } else token = request.query.access_token
            tokenlist = process.env.TOKEN_LIST ? process.env.TOKEN_LIST.split(',') : []
            limit = (tokenlist.indexOf(token) !== -1) ? 60000 : 3000
          }

          return { limit: limit, window: 60 }
        },
        enabled: true,
        methods: [ 'get', 'post', 'delete', 'put', 'patch' ],
        overLimitError: (rate) => boom.tooManyRequests(`try again in ${rate.window} seconds`),
        rateLimitKey: (request) => whitelist.ipaddr(request) + ':' + runtime.config.server.hostname,
        redisClient: runtime.config.queue.client
      }
    },
    {
      register: require('hapi-swagger'),
      options: {
        auth: {
          strategy: 'whitelist',
          mode: 'required'
        },
        info: {
          title: npminfo.name,
          version: npminfo.version,
          description: npminfo.description
        }
      }
    }
  ], function (err) {
  if (err) {
    debug('unable to register extensions', err)
    throw err
  }

  debug('extensions registered')

  if (runtime.login) {
    server.auth.strategy('github', 'bell', {
      provider: 'github',
      password: require('cryptiles').randomString(64),
      clientId: runtime.login.clientId,
      clientSecret: runtime.login.clientSecret,
      isSecure: runtime.login.isSecure,
      forceHttps: runtime.login.isSecure,
      scope: ['user:email', 'read:org']
    })
    debug('github authentication: forceHttps=' + runtime.login.isSecure)

    server.auth.strategy('session', 'cookie', {
      password: runtime.login.ironKey,
      cookie: 'sid',
      isSecure: runtime.login.isSecure
    })
  } else debug('github authentication disabled')

  server.auth.strategy('simple', 'bearer-access-token', {
    allowQueryToken: true,
    allowMultipleHeaders: false,
    validateFunc: function (token, callback) {
      var tokenlist = process.env.TOKEN_LIST && process.env.TOKEN_LIST.split(',')

      callback(null, ((!tokenlist) || (tokenlist.indexOf(token) !== -1)), { token: token }, null)
    }
  })
})

server.ext('onRequest', function (request, reply) {
  if (request.headers['x-request-id']) request.id = request.headers['x-request-id']
  debug('begin', {
    sdebug: {
      request: {
        id: request.id,
        method: request.method.toUpperCase(),
        pathname: request.url.pathname
      },
      query: request.url.query,
      params: request.url.params,
      headers: underscore.omit(request.headers, [ 'authorization', 'cookie' ])
/* N.B. do not log IP addresses regardless of whether IP-anonymization is used
      remote: { address: whitelist.ipaddr(request), port: request.headers['x-forwarded-port'] || request.info.remotePort }
 */
    }
  })

  return reply.continue()
})

server.ext('onPreResponse', function (request, reply) {
  var response = request.response

  if ((!response.isBoom) || (response.output.statusCode !== 401)) {
    if (typeof response.header === 'function') response.header('Cache-Control', 'private')
    return reply.continue()
  }

  if (request && request.auth && request.auth.session && request.auth.session.clear) {
    request.auth.session.clear()
    reply.redirect('/v1/login')
  }
})

server.on('log', function (event, tags) {
  debug(event.data, { tags: tags })
}).on('request', function (request, event, tags) {
  debug(event.data, { tags: tags }, { sdebug: { request: { id: event.request, internal: event.internal } } })
}).on('response', function (request) {
  var flattened
  var logger = request._logger || []
  var params = {
    request:
    { id: request.id,
      method: request.method.toUpperCase(),
      pathname: request.url.pathname,
      statusCode: request.response.statusCode
    },
    headers: request.response.headers,
    error: braveHapi.error.inspect(request.response._error)
  }

  if ((request.response.statusCode === 401) || (request.response.statusCode === 406)) {
    runtime.notify(debug, { text: JSON.stringify(underscore.extend({ address: whitelist.ipaddr(request) }, params.request)) })
  }

  logger.forEach((entry) => {
    if ((entry.data) && (typeof entry.data.msec === 'number')) { params.request.duration = entry.data.msec }
  })

  if ((newrelic) && (request.response._error)) {
    flattened = {}
    underscore.keys(params).forEach(param => {
      underscore.keys(params[param]).forEach(key => {
        if ((param === 'error') && ((key === 'message') || (key === 'payload') || (key === 'stack'))) return

        flattened[param + '.' + key] = params[param][key]
      })
    })
    flattened.url = flattened['request.pathname']
    delete flattened['request.pathname']
    newrelic.noticeError(request.response._error, flattened)
  }

  debug('end', { sdebug: params })
})

var main = async function (id) {
  var routing = await routes.routes(debug, runtime)

  server.route(routing)
  server.route({ method: 'GET', path: '/favicon.ico', handler: { file: './documentation/favicon.ico' } })
  server.route({ method: 'GET', path: '/favicon.png', handler: { file: './documentation/favicon.png' } })
  server.route({ method: 'GET', path: '/robots.txt', handler: { file: './documentation/robots.txt' } })
  server.route({ method: 'GET', path: '/assets/{path*}', handler: { file: './documentation/robots.txt' } })
  if (process.env.ACME_CHALLENGE) {
    server.route({
      method: 'GET',
      path: '/.well-known/acme-challenge/' + process.env.ACME_CHALLENGE.split('.')[0],
      handler: function (request, reply) { reply(process.env.ACME_CHALLENGE) }
    })
  }

  server.start((err) => {
    var children = {}
    var f = (m) => {
      m.children.forEach(entry => {
        var p, version
        var components = path.parse(entry.filename).dir.split(path.sep)
        var i = components.indexOf('node_modules')

        if (i >= 0) {
          p = components[i + 1]
          version = require(path.join(components.slice(0, i + 2).join(path.sep), 'package.json')).version
          if (!children[p]) children[p] = version
          else if (Array.isArray(children[p])) {
            if (children[p].indexOf(version) < 0) children[p].push(version)
          } else if (children[p] !== version) children[p] = [ children[p], version ]
        }
        f(entry)
      })
    }

    if (err) {
      debug('unable to start server', err)
      throw err
    }

    debug('webserver started',
          underscore.extend({ server: url.format(runtime.config.server), version: server.version },
                            server.info,
                            { env: underscore.pick(process.env, [ 'DEBUG', 'DYNO', 'NEW_RELIC_APP_NAME', 'NODE_ENV' ]) }))
    runtime.npminfo = underscore.pick(npminfo, 'name', 'version', 'description', 'author', 'license', 'bugs', 'homepage')
    runtime.npminfo.children = {}
    runtime.notify(debug, {
      text: require('os').hostname() + ' ' + npminfo.name + '@' + npminfo.version +
        ' started ' + (process.env.DYNO || 'web') + '/' + id
    })

    f(module)
    underscore.keys(children).sort().forEach(m => { runtime.npminfo.children[m] = children[m] })

    // Hook to notify start script.
    if (process.send) { process.send('started') }
  })
}

require('throng')({
  start: main,
  workers: process.env.WEB_CONCURRENCY || 1,
  lifetime: Infinity
})
