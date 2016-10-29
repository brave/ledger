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

var debug = new (require('sdebug'))('worker')
var path = require('path')
var workers = require('./workers/index')
var underscore = require('underscore')

var npminfo = require(path.join(__dirname, '..', 'package'))
var runtime = require('./runtime.js')
runtime.newrelic = newrelic

var main = async function (id) {
  var listeners

  debug.initialize({ worker: { id: id } })

  listeners = await workers.workers(debug, runtime)

  underscore.keys(listeners).sort().forEach((listener) => { debug(listener, listeners[listener].sort()) })

  runtime.npminfo = underscore.pick(npminfo, 'name', 'version', 'description', 'author', 'license', 'bugs', 'homepage')
  runtime.npminfo.children = {}
  runtime.notify(debug, { text: require('os').hostname() + ' ' + npminfo.name + '@' + npminfo.version +
                                  ' started ' + (process.env.DYNO || 'worker') + '/' + id })
}

main(1)
