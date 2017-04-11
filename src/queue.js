var bluebird = require('bluebird')
var debug = new (require('sdebug'))('queue')
var redis = require('redis')
var underscore = require('underscore')

bluebird.promisifyAll(redis.RedisClient.prototype)
bluebird.promisifyAll(redis.Multi.prototype)

var Queue = function (config, runtime) {
  if (!(this instanceof Queue)) return new Queue(config)

  if (!config.queue) throw new Error('config.queue undefined')

  if (config.queue.rsmq) config.queue = config.queue.rsmq
  if (typeof config.queue === 'string') {
    if (config.queue.indexOf('redis://') === -1) config.queue = 'redis://' + config.queue
    config.queue = { client: redis.createClient(config.queue) }
  }
  this.rsmq = new (require('rsmq'))(config.queue)
  this.runtime = runtime

  this.rsmq.on('connect', function () { debug('redis connect') })
    .on('disconnect', function () { debug('redis disconnect') })
    .on('error', function (err) {
      debug('redis error', err)
      this.runtime.notify(debug, { text: 'redis error: ' + err.toString() })
    })
}

Queue.prototype.create = async function (name) {
  var self = this

  return new Promise((resolve, reject) => {
    self.rsmq.listQueues((err, rsp) => {
      if (err) {
        debug('listQueues failed')
        return reject(err)
      }
      if (rsp.indexOf(name) !== -1) return resolve(false)

      self.rsmq.createQueue({ qname: name }, function (err, rsp) {
        if (err) {
          debug('createQueue ' + name + ' failed')
          return reject(err)
        }

        if (rsp !== 1) return reject(new Error('createQueue ' + name + ' failed: unknown response'))
        resolve(true)
      })
    })
  })
}

Queue.prototype.drop = async function (name) {
  var self = this

  return new Promise((resolve, reject) => {
    self.rsmq.listQueues((err, rsp) => {
      if (err) {
        debug('listQueues failed')
        return reject(err)
      }
      if (rsp.indexOf(name) === -1) return resolve(false)

      self.rsmq.deleteQueue({ qname: name }, function (err, rsp) {
        if (err) {
          debug('deleteQueue ' + name + ' failed')
          return reject(err)
        }

        if (rsp !== 1) return reject(new Error('deleteQueue ' + name + ' failed: unknown response'))
        resolve(true)
      })
    })
  })
}

Queue.prototype.send = async function (debug, name, payload) {
  var self = this

  return new Promise((resolve, reject) => {
    self.rsmq.sendMessage({ qname: name, message: JSON.stringify(payload) }, function (err, rsp) {
      if (err) {
        debug('sendMessage ' + name + ' failed', payload)
        return reject(err)
      }

      if (!rsp) return reject(new Error('sendMessage failed: unknown response'))

      debug('send', JSON.stringify({ queue: name, message: payload }, null, 2))
      resolve(rsp)
    })
  })
}

Queue.prototype.recv = async function (name) {
  var self = this

  return new Promise((resolve, reject) => {
    self.rsmq.receiveMessage({ qname: name }, function (err, rsp) {
      if (err) {
        debug('receiveMessage ' + name + ' failed')
        return reject(err)
      }

      if ((!rsp) || (!rsp.id)) return null

      try { rsp.payload = JSON.parse(rsp.message) } catch (ex) {
        debug('receiveMessage ' + name + ' parsing failed', rsp)
        return reject(ex)
      }
      delete rsp.message

      debug('recv', JSON.stringify({ queue: name, message: rsp }, null, 2))
      resolve(rsp)
    })
  })
}

Queue.prototype.remove = async function (name, id) {
  var self = this

  return new Promise((resolve, reject) => {
    self.rsmq.deleteMessage({ qname: name, id: id }, function (err, rsp) {
      if (err) {
        debug('deleteMessage ' + name + ' id=' + id + ' failed')
        return reject(err)
      }

      return resolve(rsp === 1)
    })
  })
}

Queue.prototype.listen = function (name, callback) {
  var options = {
    host: this.rsmq.redis.options.host,
    port: this.rsmq.redis.options.port,
    options: underscore.omit(this.rsmq.redis.options, [ 'host', 'port' ])
  }
  var worker = new (require('rsmq-worker'))(name, options)

  var oops = function (message, err) {
    debug(message, err)
    if (err) message += ', ' + err.toString()
    this.runtime.notify(debug, { text: message })
  }

  worker.on('message', function (message, next, id) {
    var payload
    var rsp = { id: id, message: message }
    var sdebug = new (require('sdebug'))('queue')

    sdebug.initialize({ request: { id: id } })
    try {
      payload = JSON.parse(message)

      sdebug('recv', JSON.stringify({ queue: name, message: payload }, null, 2))
      callback(null, sdebug, payload)
    } catch (ex) {
      debug('listenMessage ' + name + ' parsing failed', rsp)
    }

    return next()
  })

  worker.on('error', function (err, msg) { oops('redis error: id=' + msg.id, err) })
    .on('exceeded', function (msg) { oops('redis exceeded: id=' + msg.id) })
    .on('timeout', function (msg) { oops('redis timeout: id=' + msg.id + ' rc=' + msg.rc) })

  worker.start()
}

module.exports = Queue
