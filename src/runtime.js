var underscore = require('underscore')

var DB = require('./database')
var Queue = require('./queue')
var Wallet = require('./wallet')

var profile = process.env.NODE_ENV || 'development'
var config = require('../config/config.' + profile + '.js')

underscore.keys(config).forEach((key) => {
  var m = config[key]
  if (typeof m === 'undefined') return

  underscore.keys(m).forEach((k) => {
    if (typeof m[k] === 'undefined') throw new Error('config.' + key + '.' + k + ': undefined')

    if ((typeof m[k] !== 'number') && (typeof m[k] !== 'boolean') && (!m[k])) {
      throw new Error('config.' + key + '.' + k + ': empty')
    }
  })
})

var runtime = {
  config: config,
  db: new DB(config),
  login: config.login,
  queue: new Queue(config)
}
runtime.wallet = new Wallet(config, runtime)

module.exports = runtime
