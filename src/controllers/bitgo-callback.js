var braveHapi = require('../brave-hapi')
var bson = require('bson')
var Joi = require('joi')
var underscore = require('underscore')
var uuid = require('node-uuid')

var v1 = {}

/*
    POST /callbacks/bitgo/sink (from the BitGo server)
 */

/*
    { hash     : '...'
    , type     : 'transaction'
    , walletId : '...'
    }
 */

v1.sink =
{ handler: function (runtime) {
  return async function (request, reply) {
    var wallet, state
    var debug = braveHapi.debug(module, request)
    var payload = request.payload || {}
    var address = payload.walletId
    var wallets = runtime.db.get('wallets', debug)
    var webhooks = runtime.db.get('webhooks', debug)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { provider: 'bitgo', payload: payload }
            }
    await webhooks.update({ webhookId: uuid.v4().toLowerCase() }, state, { upsert: true })

    reply({})

    wallet = await wallets.findOne({ address: address })
    if (!wallet) return debug('no such bitgo wallet', payload)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { balances: await runtime.wallet.balances(wallet) }
            }
    await wallets.update({ paymentId: wallet.paymentId }, state, { upsert: true })

    await runtime.queue.send(debug, 'wallet-report', underscore.extend({ paymentId: wallet.paymentId }, state.$set))
  }
},

  description: 'Webhooks',
  tags: [ 'api' ],

  validate:
    { payload: Joi.object().keys().unknown(true) },

  response:
    { schema: Joi.object().length(0) }
}

module.exports.routes = [ braveHapi.routes.async().post().path('/callbacks/bitgo/sink').config(v1.sink) ]

module.exports.initialize = async function (debug, runtime) {
  runtime.db.checkIndices(debug,
  [ { category: runtime.db.get('webhooks', debug),
      name: 'webhooks',
      property: 'webhookId',
      empty: { webhookId: '', provider: '', payload: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { webhookId: 0 } ],
      others: [ { provider: 1 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('wallet-report')
}
