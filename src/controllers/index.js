var fs = require('fs')
var path = require('path')
var underscore = require('underscore')

var exports = {}

exports.routes = async function (debug, runtime) {
  var i, names
  var entries = {}
  var routes = [
    { method: 'GET',
      path: '/',
      config: { handler: (request, reply) => { reply('ack.') } }
    }
  ]

  var router = async function (name) {
    var module = require(path.join(__dirname, name))
    var routing = module.routes

    if (typeof module.initialize === 'function') routing = (await module.initialize(debug, runtime)) || routing

    if (!underscore.isArray(routing)) return []

    routing.forEach(route => {
      var entry = route(runtime)
      var key = entry.method + ' ' + entry.path

      if (((typeof entry.config.auth !== 'undefined') || (entry.path.indexOf('/logout') !== -1)) && (!runtime.login)) {
        debug('no authentication configured for route ' + key)
        return
      }

      if (entries[key]) { debug('duplicate route ' + key) } else { entries[key] = true }
      routes.push(entry)
    })
  }

  names = fs.readdirSync(__dirname)
  for (i = names.length - 1; i >= 0; i--) {
    if ((names[i] === 'index.js') || (path.extname(names[i]) !== '.js')) continue

    try {
      await router(names[i])
    } catch (ex) {
      debug('error loading routes for ' + names[i] + ': ' + ex.toString())
      console.log(ex.stack)
      process.exit(1)
    }
  }

  return routes
}

module.exports = exports
