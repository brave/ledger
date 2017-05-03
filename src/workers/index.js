var fs = require('fs')
var path = require('path')
var underscore = require('underscore')

var exports = {}

exports.workers = async function (debug, runtime) {
  var i, names
  var entries = {}
  var listeners = {}

  var register = async function (name, callback) {
    await runtime.queue.create(name)
    runtime.queue.listen(name,
      runtime.newrelic.createBackgroundTransaction(name, async function (err, debug, payload) {
        if (err) {
          runtime.notify(debug, { text: name + ' listen error: ' + err.toString() })
          return debug(name + ' listen', err)
        }

        try { await callback(debug, runtime, payload) } catch (ex) {
          debug(name, { payload: payload, err: ex, stack: ex.stack })
          runtime.newrelic.noticeError(ex, payload)
        }
        runtime.newrelic.endTransaction()
      })
    )
  }

  var router = async function (name) {
    var i, key, names
    var module = require(path.join(__dirname, name))
    var working = module.workers

    if (typeof module.initialize === 'function') working = (await module.initialize(debug, runtime)) || working
    name = path.basename(name, '.js')
    listeners[name] = []

    names = underscore.keys(working)
    for (i = names.length - 1; i >= 0; i--) {
      key = names[i]
      if (entries[key]) {
        debug('duplicate worker ' + key)
        continue
      }

      await register(key, working[key])
      listeners[name].push(key)
    }
  }

  names = fs.readdirSync(__dirname)
  for (i = names.length - 1; i >= 0; i--) {
    if ((names[i] === 'index.js') || (path.extname(names[i]) !== '.js')) continue

    try {
      await router(names[i])
    } catch (ex) {
      debug('error loading workers for ' + names[i] + ': ' + ex.toString())
      console.log(ex.stack)
      process.exit(1)
    }
  }

  return listeners
}

module.exports = exports
