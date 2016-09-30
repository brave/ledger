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

var Hapi = require('hapi')

var braveHapi = require('./brave-hapi')
var debug = new (require('sdebug'))('server')
var path = require('path')
var routes = require('./controllers/index')
var underscore = require('underscore')
var util = require('util')

var npminfo = require(path.join(__dirname, '..', 'package'))
var runtime = require('./runtime.js')
runtime.newrelic = newrelic

var server = new Hapi.Server()
server.connection({ port: runtime.config.port })

debug.initialize({ 'server': { id: server.info.id } })

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
  require('hapi-auth-cookie'),
  require('inert'),
  require('vision'),
  {
    register: require('hapi-swagger'),
    options: {
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

  if (runtime.login && !process.env.GITHUB_DISABLE_AUTHENTICATION) {
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
})

server.ext('onRequest', function (request, reply) {
  if (request.headers['x-request-id']) request.id = request.headers['x-request-id']
  debug('begin',
        { sdebug:
          { request:
            { id: request.id,
              method: request.method.toUpperCase(),
              pathname: request.url.pathname
            },
            query: request.url.query,
            params: request.url.params,
            headers: underscore.omit(request.headers, 'cookie')
/* N.B. do not log IP addresses regardless of whether IP-anonymization is used
            remote:
            { address: (request.headers['x-forwarded-for'] || request.info.remoteAddress).split(', ')[0],
              port: request.headers['x-forwarded-port'] || request.info.remotePort
            }
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

  request.auth.session.clear()
  reply.redirect('/v1/login')
})

server.on('log', function (event, tags) {
  debug(event.data, { tags: tags })
}).on('request', function (request, event, tags) {
  debug(event.data,
        { tags: tags },
        { sdebug:
          { request:
            { id: event.request,
              internal: event.internal
            }
          }
        })
}).on('response', function (request) {
  var flattened
  var logger = request._logger || []
  var params = { request:
                 { id: request.id,
                   method: request.method.toUpperCase(),
                   pathname: request.url.pathname,
                   statusCode: request.response.statusCode
                 },
                 headers: request.response.headers,
                 error: braveHapi.error.inspect(request.response._error)
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

var main = async function () {
  var routing = await routes.routes(debug, runtime)

  server.route(routing)
  server.route({ method: 'GET', path: '/favicon.ico', handler: { file: './documentation/favicon.ico' } })
  server.route({ method: 'GET', path: '/robots.txt', handler: { file: './documentation/robots.txt' } })

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
          else if (util.isArray(children[p])) {
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
    { protocol: server.info.protocol,
      address: server.info.address,
      port: runtime.config.port,
      version: server.version,
      env: underscore.pick(process.env,
                           [ 'BITGO_CUSTOM_ROOT_URI', 'BITGO_ENVIRONMENT', 'DEBUG', 'DYNO', 'NEW_RELIC_APP_NAME', 'NODE_ENV' ])
    })

    runtime.npminfo = underscore.pick(npminfo, 'name', 'version', 'description', 'author', 'license', 'bugs', 'homepage')
    runtime.npminfo.children = {}

    f(module)
    underscore.keys(children).sort().forEach(m => { runtime.npminfo.children[m] = children[m] })

    // Hook to notify start script.
    if (process.send) { process.send('started') }
  })
}

main()
